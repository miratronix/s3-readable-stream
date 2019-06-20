# s3-readable-stream
[![NPM](https://nodei.co/npm/s3-readable-stream.png)](https://npmjs.org/package/s3-readable-stream)

A simple robust download stream for S3.

## Features
* Configurable download chunk retries.
* Intelligent setting of headers when piping to a response.
* `Range` header support.

## Installation
Install via NPM: `npm install --save s3-readable-stream`

## Usage
To create a download stream, simply construct it and use it like a standard stream:
```javascript
const fs = require('fs');
const aws = require('aws-sdk');
const S3ReadableStream = require('s3-readable-stream');

// Construct the S3 client
const s3Client = new aws.S3({
   accessKeyId: 'ACCESS_KEY_ID',
   secretAccessKey: 'SECRET_ACCESS_KEY',
   region: 'AWS_REGION'
});

// Create a standard S3 getObject param object
const fileOptions = {
    Bucket: 'SOME_BUCKET',
    Key: 'SOME_KEY'
};

// Create the stream
const stream = new S3ReadableStream(s3Client, fileOptions);

// Attach some events
stream.on('error', (err) => {});
stream.on('open', (data) => {});
stream.on('close', () => {});

// Pipe it somewhere
stream.pipe(fs.createWriteStream('/somewhere'));
```

## Usage With Express
s3-readable-stream will set all HTTP headers as required when piped to a stream that supports that. For example, to pipe
a file from S3 in an express router:
```javascript
const router = require('express').Router();
const aws = require('aws-sdk');
const S3ReadableStream = require('s3-readable-stream');

// Construct the S3 client
const s3Client = new aws.S3({
   accessKeyId: 'ACCESS_KEY_ID',
   secretAccessKey: 'SECRET_ACCESS_KEY',
   region: 'AWS_REGION'
});

router.get('/download', (req, res, next) => {
  
    // Create the S3 getObject params, with support for a range header
    const fileOptions = {
        Bucket: 'SOME_BUCKET',
        Key: 'SOME_KEY',
        Range: req.headers.range
    };
    
    // Set a header indicating a download attachment
    res.setHeader('Content-Disposition', 'attachment; filename="file.txt"');
    
    // Construct the stream 
    const stream = new S3ReadableStream(s3Client, fileOptions);
    
    // Attach an error handler
    stream.on('error', next);
    
    // Pipe to the response.
    stream.pipe(res);
    
    // S3 Readable stream will set the following headers:
    // * Content-Type
    // * Content-Length
    // * Accept-Ranges
    
    // Additionally, if a range header was supplied, the status code will be set to a 206, and the Content-Range header
    // will be set.
    
    // Destroy the stream if the client disconnects
    res.on('close', stream.destroy);
});
```

## Configuration Options
When constructing an S3 Readable Stream, the following options can be supplied, with the indicated defaults:
```javascript
const stream = new S3ReadableStream(s3Client, fileOptions, {
    
    // The number of concurrent requests to make
    concurrency: 6,
    
    // The size of each downloaded chunk
    chunkSize: 64 * 1024,
    
    // The max number of retries to make for each chunk download
    chunkRetries: 5,
    
    // The exponential back off factor when retrying a chunk download
    chunkRetryFactor: 1,
    
    // The minimum interval before retrying a chunk download
    chunkRetryMinInterval: 0,
    
    // The maximum interval before retrying a chunk download
    chunkRetryMaxInterval: 0
    
});
```
