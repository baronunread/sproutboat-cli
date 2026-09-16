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

## Direct transfers in deployed and local-dev mode

If the client can send the file directly, a broker-backed transfer ticket avoids
the sprout's request-body buffer entirely. Create a short-lived ticket in an
authenticated sprout route and give its same-origin `url` to the client:

```js
// Validate the client's file size and authorization before issuing a ticket.
const ticket = env.FILES.createUploadUrl("backups/site.tar", {
  maxBytes: fileSize,
  httpMetadata: { contentType: "application/x-tar" },
});
// Return ticket.url and ticket.expiresAt to the authorized client.
```

```js
const response = await fetch(ticket.url, { method: "PUT", body: file });
if (!response.ok) throw new Error(`upload failed: ${response.status}`);
```

`createDownloadUrl(key)` creates a one-use `GET` or `HEAD` ticket. Download
requests support a single `Range: bytes=start-end` header and return `206` with
`Content-Range`. A successful upload returns `201` and object metadata. Tickets
are bearer capabilities, last 15 minutes by default, and are used only once.
Do not log or publish their URLs. Create a new ticket for a retry, including
after a network interruption. Set `sha256` on an upload ticket to reject a
body with the wrong digest. The default maximum upload is 100 MiB; the broker's
`SB_R2_TRANSFER_MAX_BYTES` caps the maximum a ticket can request.
The deployed edge also has a 5 GiB HTTP body cap by default, configurable with
`SPROUTBOAT_EDGE_MAX_BODY_BYTES`; both caps must allow the intended file size.
The direct-transfer request timeout defaults to ten minutes.
An idle connection with no bytes sent or received for 255 seconds is closed.

Native standalone sprouts do not yet serve the direct-transfer path. Use the
multipart recipe above there. `env.FILES.get()` still reads an entire object
into memory in every mode, so use download tickets for large broker-backed
downloads. The native standalone streaming requirement is tracked in
[sproutboat#56](https://github.com/baronunread/sproutboat/issues/56).
