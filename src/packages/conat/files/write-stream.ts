import type { Writable } from "node:stream";
import { abortable } from "../core/abort";
import { readIdleWait } from "./read-flow";
import { getLogger } from "@cocalc/conat/logger";

const logger = getLogger("conat:files:write-stream");

export type FileWriteStream = Writable & {
  commit?: () => Promise<void>;
  remove?: () => Promise<void>;
};

// Keep runtime imports browser-compatible: writeFile is also a browser API.
function waitForStream(
  stream: FileWriteStream,
  event: "drain" | "finish",
  signal: AbortSignal,
  start: () => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off(event, done);
      signal.removeEventListener("abort", aborted);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    stream.once(event, done);
    signal.addEventListener("abort", aborted, { once: true });
    try {
      signal.throwIfAborted();
      if (start()) done();
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

export async function copyToWriteStream({
  open,
  source,
  maxWait,
}: {
  open: () => FileWriteStream | Promise<FileWriteStream>;
  source: (signal: AbortSignal) => AsyncIterable<Uint8Array>;
  maxWait: number;
}): Promise<{ bytes: number; chunks: number }> {
  const controller = new AbortController();
  const { signal } = controller;
  let stream: FileWriteStream | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const progress = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(Error("file write timed out")),
      readIdleWait(maxWait),
    );
    timer.unref?.();
  };
  const failed = (err: Error) => controller.abort(err);
  const closed = () => {
    if (!stream?.writableFinished)
      failed(Error("file write destination closed"));
  };
  const destroy = () => stream?.destroy();
  const remove = async (value: FileWriteStream) => {
    try {
      value.destroy();
      if (value.remove) await value.remove();
      else value.emit("remove");
    } catch (err) {
      logger.warn("partial upload cleanup failed", { err: `${err}` });
    }
  };
  progress();
  signal.addEventListener("abort", destroy, { once: true });
  try {
    const opening = Promise.resolve()
      .then(open)
      .then(async (value) => {
        // If opening outlives cancellation, it must not leave a partial file or
        // emit an unhandled stream error after the request has gone away.
        if (signal.aborted) {
          value.on("error", () => {});
          await remove(value);
          signal.throwIfAborted();
        }
        return value;
      });
    stream = await abortable(opening, signal);
    stream.on("error", failed);
    stream.on("close", closed);
    if (stream.destroyed) closed();
    signal.throwIfAborted();
    let bytes = 0;
    let chunks = 0;
    for await (const chunk of source(signal)) {
      // readFile ACKs only when we request the next chunk. Do not advance it
      // while the destination's bounded writable buffer is still full.
      await waitForStream(stream, "drain", signal, () => stream!.write(chunk));
      bytes += chunk.byteLength;
      chunks++;
      if (chunk.byteLength) progress();
    }
    await waitForStream(stream, "finish", signal, () => {
      stream!.end();
      return stream!.writableFinished;
    });
    signal.throwIfAborted();
    // Finishing the bytes is not sufficient for atomic-upload factories:
    // their rename can fail too, and success must follow that commit.
    if (stream.commit) await abortable(stream.commit(), signal);
    else stream.emit("rename");
    return { bytes, chunks };
  } catch (err) {
    controller.abort(err);
    if (stream) await remove(stream);
    throw err;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", destroy);
    stream?.off("close", closed);
    // Leave the error listener on the destroyed stream: an in-flight native
    // write may report its error after cancellation and cleanup have finished.
  }
}
