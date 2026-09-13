import { Writable } from "node:stream";
import { copyToWriteStream, type FileWriteStream } from "./write-stream";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("destination backpressure and completion", () => {
  it("destroys and removes a destination that opens after timeout", async () => {
    let opened!: (stream: FileWriteStream) => void;
    const source = jest.fn(async function* () {});
    const failed = expect(
      copyToWriteStream({
        open: () =>
          new Promise<FileWriteStream>((resolve) => {
            opened = resolve;
          }),
        source,
        maxWait: 30,
      }),
    ).rejects.toThrow("timed out");
    await failed;
    const stream: FileWriteStream = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });
    stream.remove = jest.fn(async () => {});
    opened(stream);
    await tick();
    expect(stream.destroyed).toBe(true);
    expect(stream.remove).toHaveBeenCalledTimes(1);
    expect(source).not.toHaveBeenCalled();
  });

  it("does not advance the source before drain, or commit before finish", async () => {
    let write!: () => void;
    let finish!: () => void;
    const sink: FileWriteStream = new Writable({
      highWaterMark: 1,
      write(_chunk, _enc, callback) {
        write = callback;
      },
      final(callback) {
        finish = callback;
      },
    });
    let consumed = 0;
    let commit!: () => void;
    sink.commit = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          commit = resolve;
        }),
    );
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    const result = copyToWriteStream({
      open: () => sink,
      maxWait: 10000,
      source: async function* () {
        for (let i = 0; i < 4; i++) {
          yield chunk;
          consumed++;
        }
      },
    });
    let completed = false;
    void result.then(() => {
      completed = true;
    });
    for (let i = 0; i < 4; i++) {
      await tick();
      expect(consumed).toBe(i);
      expect(sink.writableLength).toBe(chunk.length);
      expect(completed).toBe(false);
      write();
    }
    await tick();
    expect(sink.commit).not.toHaveBeenCalled();
    expect(completed).toBe(false);
    finish();
    await tick();
    expect(sink.writableFinished).toBe(true);
    expect(sink.commit).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
    commit();
    await expect(result).resolves.toEqual({
      bytes: 16 * 1024 * 1024,
      chunks: 4,
    });
    expect(sink.listenerCount("drain")).toBe(0);
    expect(sink.listenerCount("finish")).toBe(0);
  });

  it.each(["close", "error", "timeout"])(
    "cancels a blocked sink on %s and removes the partial file",
    async (reason) => {
      const sink: FileWriteStream = new Writable({
        highWaterMark: 1,
        write() {},
      });
      sink.remove = jest.fn(async () => {});
      sink.commit = jest.fn(async () => {});
      let signal!: AbortSignal;
      let returned = false;
      const result = copyToWriteStream({
        open: () => sink,
        maxWait: reason === "timeout" ? 40 : 10000,
        source: async function* (value) {
          signal = value;
          try {
            yield Buffer.alloc(64);
          } finally {
            returned = true;
          }
        },
      });
      const failed = expect(result).rejects.toThrow();
      await tick();
      if (reason === "close") sink.destroy();
      if (reason === "error") sink.destroy(Error("disk full"));
      await failed;
      expect(signal.aborted).toBe(true);
      expect(returned).toBe(true);
      expect(sink.remove).toHaveBeenCalledTimes(1);
      expect(sink.commit).not.toHaveBeenCalled();
      expect(sink.listenerCount("drain")).toBe(0);
    },
  );

  it.each(["finish", "commit"])(
    "reports %s failure rather than success",
    async (where) => {
      const sink: FileWriteStream = new Writable({
        write(_c, _e, cb) {
          cb();
        },
        final(cb) {
          cb(where === "finish" ? Error("finish failed") : undefined);
        },
      });
      sink.commit = jest.fn(async () => {
        throw Error("commit failed");
      });
      sink.remove = jest.fn(async () => {});
      await expect(
        copyToWriteStream({
          open: () => sink,
          maxWait: 1000,
          source: async function* () {
            yield Buffer.alloc(1);
          },
        }),
      ).rejects.toThrow(`${where} failed`);
      expect(sink.remove).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves rename/remove event hooks for legacy factories", async () => {
    const sink = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });
    const rename = jest.fn(() => expect(sink.writableFinished).toBe(true));
    const remove = jest.fn();
    sink.on("rename", rename);
    sink.on("remove", remove);
    await copyToWriteStream({
      open: () => sink,
      maxWait: 1000,
      source: async function* () {},
    });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });
});
