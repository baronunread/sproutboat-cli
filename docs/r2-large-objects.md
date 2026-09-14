# Large R2 objects

Use multipart uploads when an object is larger than one safe request body.
Sproutboat persists each part independently and assembles the final object
without putting the entire object in the sprout heap.

```js
const upload = env.FILES.createMultipartUpload("backups/site.tar", {
  httpMetadata: { contentType: "application/x-tar" },
  customMetadata: { source: "nightly-backup" },
});

const completedParts = [];
completedParts.push(upload.uploadPart(1, firstChunk));

// Store key and uploadId if the upload must survive a process restart.
const resumed = env.FILES.resumeMultipartUpload(upload.key, upload.uploadId);
completedParts.push(resumed.uploadPart(2, finalChunk));

const object = resumed.complete(completedParts);
```

The methods are synchronous in compiled sprout code. `await` is harmless and
can make shared Worker code easier to reuse.

## Choosing a part size

The default inbound request-body limit is 1 MiB. Use 512 KiB to 900 KiB parts
when each part arrives in its own HTTP request, leaving room for application
framing. Raising `SB_REQUEST_BODY_MAX` also raises the amount one request can
make the process allocate, so small parts are the safer default.

Part numbers range from 1 to 10,000. Supply the returned `{ partNumber, etag }`
records to `complete()` in ascending order. Every part except the last must
have the same size, and the last cannot be larger.

An unfinished upload expires after seven days. Call `abort()` when abandoning
one early so its part files can be reclaimed immediately.

## Browser upload shape

Do not send a large browser file to one sprout route and split it inside the
handler. The HTTP server has already buffered the complete request before the
handler runs. Split the `File` in the browser, then send one part per request:

```js
const partSize = 768 * 1024;
const completed = [];

for (let offset = 0, partNumber = 1; offset < file.size; offset += partSize, partNumber++) {
  const body = file.slice(offset, offset + partSize);
  const response = await fetch(`/uploads/${uploadId}/parts/${partNumber}`, {
    method: "PUT",
    body,
  });
  completed.push(await response.json());
}
```

Keep `uploadId`, the object key, and completed part records on the client or in
application storage so an interrupted upload can resume.

## Current download limit

Multipart bounds upload memory by part size, but `env.FILES.get()` still reads
the complete object into memory. Keep downloads modest until native download
tickets and HTTP Range support land. A direct native transfer path is tracked
in [sproutboat#56](https://github.com/baronunread/sproutboat/issues/56).
