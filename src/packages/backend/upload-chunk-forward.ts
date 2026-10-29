/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Forwarding one uploaded chunk into the upload's destination stream, shared by
the hub, lite and project-host upload handlers.

A stream 'error' event with no listener is an uncaught exception, which exits
the whole server. So a failed destination (its backend write failed and ended
or destroyed it while chunks were still arriving) must fail that one upload:
both streams always have an error listener, and once the destination has
ended, failed or been destroyed, the rest of the chunk is drained instead of
written, so its request still completes.
*/

import type { PassThrough } from "node:stream";
import getLogger from "./logger";

const logger = getLogger("upload-chunk-forward");

// destinations that already have their permanent error listener (one per
// destination, which outlives the chunks forwarded into it)
const listened = new WeakSet<PassThrough>();

function listenForErrors(stream: PassThrough, what: string): void {
  if (listened.has(stream)) return;
  listened.add(stream);
  stream.on("error", (err) => {
    logger.debug(`upload ${what} stream failed`, { err: `${err}` });
  });
}

export function forwardUploadChunkStream({
  chunkStream,
  totalStream,
  onError,
  onDone,
}: {
  chunkStream: PassThrough;
  totalStream: PassThrough;
  onError: (err: unknown) => void;
  onDone: () => void;
}): void {
  const finish = () => {
    try {
      onDone();
    } catch (err) {
      logger.warn("upload chunk completion callback failed", { err: `${err}` });
    }
  };
  listenForErrors(chunkStream, "chunk");
  listenForErrors(totalStream, "destination");
  let destinationError: unknown;
  const onDestinationError = (err: unknown) => {
    if (destinationError == null) destinationError = err;
  };
  totalStream.on("error", onDestinationError);
  void (async () => {
    try {
      for await (const data of chunkStream) {
        if (
          destinationError == null &&
          (totalStream.destroyed || totalStream.writableEnded)
        ) {
          // (destroy(err) marks it destroyed at once, but emits err later)
          destinationError =
            totalStream.errored ??
            new Error("upload destination closed before the upload finished");
        }
        if (destinationError != null) continue; // drain
        totalStream.write(data);
      }
    } finally {
      totalStream.off("error", onDestinationError);
    }
    if (destinationError != null) throw destinationError;
  })().then(finish, (err) => {
    totalStream.destroy();
    try {
      onError(err);
    } catch (callbackErr) {
      logger.warn("upload chunk error callback failed", {
        err: `${callbackErr}`,
      });
    }
    finish();
  });
}
