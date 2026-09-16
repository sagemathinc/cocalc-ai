# CoCalc Lite blobs

[upload.ts](./upload.ts) accepts multipart `POST /blobs` uploads. The response
contains a `uuid` derived from the file's SHA-1 hash, not the raw hash string.
[download.ts](./download.ts) serves `/blobs/<filename>?uuid=<uuid>` and reads
from the Conat AKV store named `blobs`, keyed by that UUID.

The filename controls the response name and whether a supported raster image
is displayed inline; `download` requests an attachment. A missing or invalid
UUID returns an error rather than selecting a blob by filename.

This implementation is separate from the hosted hub's blob backend. Hosted
storage is selected by [server/blobs/config.ts](../../../server/blobs/config.ts)
and can use Postgres or R2; it is not always stored entirely in Postgres.

The former suggestion to add a background synchronization task was a design
idea, not a promise that Lite uploads are automatically copied to a hosted site.
