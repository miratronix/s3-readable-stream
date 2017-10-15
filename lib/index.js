'use strict';

const _ = require('lodash');
const { Readable } = require('stream');
const promiseRetry = require('promise-retry');

const defaults = {
    concurrency: 6,
    chunkSize: 64 * 1024,
    chunkRetries: 5,
    chunkRetryFactor: 1,
    chunkRetryMinInterval: 0,
    chunkRetryMaxInterval: 0
};

class S3ReadableStream extends Readable {

    constructor (client, s3Params, options) {
        super(options);

        if (!client || !_.isFunction(client.getObject) || !_.isFunction(client.headObject)) {
            throw new Error('An S3 client with the getObject and headObject methods is required');
        }

        if (!_.has(s3Params, 'Bucket') || !_.has(s3Params, 'Key')) {
            throw new Error('Bucket and Key are required in the options object');
        }

        this.client = client;
        this.s3Params = s3Params;
        this.options = _.defaults(options, defaults);

        this.pendingRequests = [];
        this.headerPromise = null;
        this.errorEmitted = false;
        this.destroyed = false;
        this.promiseChain = Promise.resolve();
        this.bytesRead = 0;

        this.rangeSupplied = false;
        this.currentPosition = 0;
        this.maxPosition = null;
        this.contentLength = null;

        if (this.s3Params.Range) {
            this.rangeSupplied = true;

            // Parse the range
            const byteRange = _.split(_.last(_.split(s3Params.Range, '=')), '-');
            let startByte = _.first(byteRange);
            let endByte = _.last(byteRange);

            if (_.isEmpty(startByte)) {
                startByte = 0;
            } else {
                startByte = _.toNumber(startByte);
            }

            if (_.isEmpty(endByte)) {
                endByte = null;
            } else {
                startByte = _.toNumber(endByte);
            }

            // Validate the start of the range
            if (!_.isFinite(startByte) || startByte < 0) {
                throw new Error('Unsupported Range header');
            }

            // Validate the end byte if it was supplied
            if (!_.isNull(endByte)) {

                if (!_.isFinite(endByte) || endByte < 0) {
                    throw new Error('Invalid Range header');
                }

                if (startByte >= endByte) {
                    throw new Error('Invalid Range header');
                }

                this.maxPosition = endByte;
            }

            // Set the current position to the start specified
            this.currentPosition = startByte;
        }

        // Prepare promise-retry options
        this.retryOptions = {
            retries: this.options.chunkRetries,
            factor: this.options.chunkRetryFactor,
            minTimeout: this.options.chunkRetryMinInterval,
            maxTimeout: this.options.chunkRetryMaxInterval
        };
    }

    initializeHeaders () {

        // If we're already in the processing of retrieving headers, return that promise
        if (this.headerPromise) {
            return this.headerPromise;
        }

        const params = {
            Bucket: this.s3Params.Bucket,
            Key: this.s3Params.Key
        };

        this.headerPromise = promiseRetry(this.retryOptions, (retry) => {
            return this.client.headObject(params).promise()
                .then((res) => {

                    // If we don't know the end of the range, set it to the content length
                    if (!this.maxPosition) {
                        this.maxPosition = _.toNumber(res.ContentLength) - 1;
                    }

                    // Pull out content type and length
                    const contentType = res.ContentType;
                    this.contentLength =  this.maxPosition - this.currentPosition + 1;

                    // Emit a 'open' event, like the S3 readable stream would
                    this.emit('open', {
                        ContentLength: this.contentLength,
                        ContentType: contentType,
                        Bucket: this.options.Bucket,
                        Key: this.options.Key,
                        Body: this
                    });
                })
                .catch((err) => {

                    // If forbidden or not found, no point retrying
                    if (err && (err.code === 'NotFound' || err.code === 'Forbidden')) {
                        throw err;
                    }

                    return retry(err);
                });
        });

        return this.headerPromise;
    }

    requestRange (start, count) {
        const params = _.clone(this.s3Params);
        params.Range = `bytes=${start}-${_.clamp(start + count - 1, this.maxPosition)}`;

        return promiseRetry(this.retryOptions, (retry) => {
            return this.client.getObject(params).promise()
                .then((res) => {

                    const contentLength = _.toNumber(res.ContentLength);
                    const data = contentLength === 0 ? null : res.Body;
                    const range = params.Range;

                    return { data, contentLength, range };
                })
                .catch(retry);
        })
        .catch((error) => {

            // Explicitly resolve here, so that if the request is dropped off the queue and rejected, we don't get
            // unhandled promise rejections.
            return { error };
        });
    }

    fillPendingRequestQueue () {

        // We've been destroyed or an error has been emitted, clear everything out and do nothing
        if (this.destroyed || this.errorEmitted) {
            this.pendingRequests = [];
            return Promise.resolve();
        }

        // Fill up the request queue
        while (_.size(this.pendingRequests) < this.options.concurrency) {
            if (this.currentPosition >= this.maxPosition) {
                break;
            }

            this.pendingRequests.push(this.requestRange(this.currentPosition, this.options.chunkSize));
            this.currentPosition += this.options.chunkSize;
        }

        // Add a handler to the first request in the queue
        this.promiseChain = this.promiseChain
            .then(() => {
                const pendingRequest = _.first(this.pendingRequests);

                // No pending request to chain on or all bytes have already been sent, nothing to do
                if (!pendingRequest) {
                    return Promise.resolve();
                }

                return pendingRequest
                    .then((res) => {

                        // We've been destroyed or an error has occurred, clear everything out and do nothing
                        if (this.destroyed || this.errorEmitted || res.error) {

                            // Clear the request queue
                            this.pendingRequests = [];

                            // If it was a request failure and we haven't yet emitted an error, do so
                            if (res.error && !this.errorEmitted) {
                                this.errorEmitted = true;
                                this.emit('error', res.error);
                            }

                            return Promise.resolve();
                        }

                        // Request complete, remove it from the array
                        this.pendingRequests.shift();

                        // Push the bytes and increment our count
                        this.push(res.data);
                        this.bytesRead += _.size(res.data);

                        // That was the last chunk, push a null
                        if (this.bytesRead === this.contentLength) {
                            this.push(null);
                            return Promise.resolve();
                        }

                        // Haven't reached the end, queue up more
                        this.fillPendingRequestQueue();
                    });
            });
    }

    pipe (target, ...args) {
        if (target && _.isFunction(target.setHeader)) {
            this.once('open', (data) => {
                target.setHeader('Content-Length', data.ContentLength);
                target.setHeader('Accept-Ranges', 'bytes');

                // Only add a content type if it wasn't already set
                if (!target.getHeader('Content-Type')) {
                    target.setHeader('Content-Type', data.ContentType);
                }

                // If a range was supplied, set the status code and content range
                if (this.rangeSupplied) {

                    // Only set the status if that functionality actually exists
                    if (_.isFunction(target.status)) {
                        target.status(206);
                    }

                    target.setHeader('Content-Range', `bytes=${this.currentPosition}-${this.maxPosition}`);
                }
            });
        }
        return super.pipe(target, ...args);
    }

    _read () {
        this.initializeHeaders()
            .then(() => {
                this.fillPendingRequestQueue();
            })
            .catch((err) => {
                // Failed to initialize headers after retries, throw and close
                this.emit('error', err);
            });
    }

    destroy () {
        if (!this.destroyed) {
            this.destroyed = true;
            this.emit('close', new Error('Stream was destroyed'));
        }
    }
}

module.exports = S3ReadableStream;
