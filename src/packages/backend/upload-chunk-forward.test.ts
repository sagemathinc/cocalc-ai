/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { PassThrough } from "node:stream";
import { forwardUploadChunkStream } from "./upload-chunk-forward";

function forward(chunkStream: PassThrough, totalStream: PassThrough) {
  const onError = jest.fn();
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  forwardUploadChunkStream({
    chunkStream,
    totalStream,
    onError,
    onDone: finish,
  });
  return { onError, done };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("forwarding an upload chunk", () => {
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  beforeEach(() => {
    uncaught.length = 0;
    process.on("uncaughtException", onUncaught);
  });
  afterEach(() => {
    process.off("uncaughtException", onUncaught);
  });

  it("writes every byte and completes", async () => {
    const chunkStream = new PassThrough();
    const totalStream = new PassThrough();
    const received: Buffer[] = [];
    totalStream.on("data", (b) => received.push(b));
    const { onError, done } = forward(chunkStream, totalStream);
    chunkStream.write("ab");
    chunkStream.end("cd");
    await done;
    expect(Buffer.concat(received).toString()).toBe("abcd");
    expect(onError).not.toHaveBeenCalled();
  });

  it("fails the upload, not the process, when the destination ends while chunks still arrive", async () => {
    // the backend write failed, and its cleanup ended the destination
    const chunkStream = new PassThrough();
    const totalStream = new PassThrough();
    totalStream.resume();
    const write = jest.spyOn(totalStream, "write");
    const { onError, done } = forward(chunkStream, totalStream);
    chunkStream.write("first");
    await tick();
    totalStream.end();
    chunkStream.write("second");
    chunkStream.write("third");
    chunkStream.end();
    await done;
    await tick();

    expect(write).toHaveBeenCalledTimes(1); // nothing after the end
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "upload destination closed before the upload finished",
      }),
    );
    expect(chunkStream.readableEnded).toBe(true); // drained, so the request completes
    expect(uncaught).toEqual([]);
  });

  it("fails the upload, not the process, when the destination fails with an error", async () => {
    const chunkStream = new PassThrough();
    const totalStream = new PassThrough();
    totalStream.resume();
    const { onError, done } = forward(chunkStream, totalStream);
    chunkStream.write("first");
    await tick();
    totalStream.destroy(new Error("backend write failed"));
    chunkStream.end("second");
    await done;
    await tick();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "backend write failed" }),
    );
    expect(uncaught).toEqual([]);
  });

  it("an error after the last chunk was forwarded is still contained", async () => {
    const chunkStream = new PassThrough();
    const totalStream = new PassThrough();
    totalStream.resume();
    const { done } = forward(chunkStream, totalStream);
    chunkStream.end("only");
    await done;
    totalStream.destroy(new Error("late failure"));
    chunkStream.destroy(new Error("late chunk failure"));
    await tick();
    expect(uncaught).toEqual([]);
  });

  it("adds no error listeners per chunk to a long upload's destination", async () => {
    const totalStream = new PassThrough();
    totalStream.resume();
    for (let i = 0; i < 50; i++) {
      const chunkStream = new PassThrough();
      const { onError, done } = forward(chunkStream, totalStream);
      chunkStream.end(`chunk ${i}`);
      await done;
      expect(onError).not.toHaveBeenCalled();
    }
    expect(totalStream.listenerCount("error")).toBe(1);
  });
});
