import { once, getEventListeners } from "node:events";
import { createServer as createHttpServer, get } from "node:http";
import { createReadStream, type ReadStream } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { init, type ConatServer } from "../core/server";
import type { Client } from "../core/client";
import { createServer, close, readFile } from "./read";
import {
  READ_CHUNK_BYTES,
  READ_HANDSHAKE_WAIT,
  READ_PROTOCOL,
} from "./read-flow";
import { handleFileDownload } from "./file-download";
import { projectSubject } from "../names";

jest.setTimeout(20000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean) {
  const end = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > end) throw Error("condition timed out");
    await sleep(10);
  }
}

describe("bounded reads over real Conat and HTTP sockets", () => {
  let server: ConatServer;
  let producer: Client;
  let consumer: Client;
  let dir: string;
  let source: string;
  const project_id = "00000000-1000-4000-8000-000000000099";
  const name = ":backpressure";
  let streams: ReadStream[];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "bounded-read-"));
    source = join(dir, "large.bin");
    const file = await open(source, "w");
    await file.truncate(8192 * 1024 * 1024);
    await file.close();
    server = init({ port: 0, autoscanInterval: 0 });
    if (server.state !== "ready") await once(server, "ready");
    producer = server.client({ noCache: true });
    consumer = server.client({ noCache: true });
  });

  beforeEach(async () => {
    streams = [];
    await createServer({
      client: producer,
      project_id,
      name,
      createReadStream: (path, opts) => {
        const stream = createReadStream(path, opts);
        streams.push(stream);
        return stream;
      },
    });
  });

  afterEach(async () => {
    for (const stream of streams) stream.destroy();
    await close({ project_id, name });
  });

  afterAll(async () => {
    producer?.close();
    consumer?.close();
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it.each([64, 512, 8192])(
    "does not read ahead with a stalled consumer of a %i MiB file",
    async (mib) => {
      const controller = new AbortController();
      const reader = readFile({
        client: consumer,
        project_id,
        name,
        path: source,
        end: mib * 1024 * 1024 - 1,
        signal: controller.signal,
      });
      try {
        expect((await reader.next()).value).toHaveLength(READ_CHUNK_BYTES);
        await sleep(1000);
        // One transmitted chunk plus at most the filesystem highWaterMark.
        expect(streams[0].bytesRead).toBeLessThanOrEqual(2 * READ_CHUNK_BYTES);
        controller.abort(Error("test cancel"));
        await until(() => streams[0].destroyed);
      } finally {
        controller.abort();
        await reader.return(undefined);
      }
    },
  );

  it("returns byte-identical multi-chunk data and preserves byte ranges", async () => {
    const path = join(dir, "checksum.bin");
    const data = Buffer.alloc(3 * READ_CHUNK_BYTES + 171);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    await writeFile(path, data);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of readFile({
      client: consumer,
      project_id,
      name,
      path,
      start: 37,
      end: data.length - 82,
    })) {
      hash.update(chunk);
      bytes += chunk.length;
      await sleep(30);
    }
    expect(bytes).toBe(data.length - 118);
    expect(hash.digest("hex")).toBe(
      createHash("sha256")
        .update(data.subarray(37, data.length - 81))
        .digest("hex"),
    );
  });

  it("distinguishes a successful empty file from an expired stream", async () => {
    const empty = join(dir, "empty");
    await writeFile(empty, "");
    const reader = readFile({
      client: consumer,
      project_id,
      name,
      path: empty,
    });
    await expect(reader.next()).resolves.toMatchObject({ done: true });
    expect(streams[0].bytesRead).toBe(0);
    expect(streams[0].destroyed).toBe(true);
  });

  it("completes a progressing read that exceeds the requested idle interval", async () => {
    let bytes = 0;
    for await (const chunk of readFile({
      client: consumer,
      project_id,
      name,
      path: source,
      end: 4 * READ_CHUNK_BYTES - 1,
      maxWait: 500,
    })) {
      bytes += chunk.length;
      await sleep(100);
    }
    expect(bytes).toBe(4 * READ_CHUNK_BYTES);
  });

  it("cancels a stalled filesystem read and releases its admission slot", async () => {
    await close({ project_id, name });
    let first = true;
    const blocked = new PassThrough();
    await createServer({
      client: producer,
      project_id,
      name,
      maxActiveStreams: 1,
      createReadStream: (path, opts) => {
        if (first) {
          first = false;
          return blocked;
        }
        return createReadStream(path, opts);
      },
    });
    const controller = new AbortController();
    const reader = readFile({
      client: consumer,
      project_id,
      name,
      path: source,
      signal: controller.signal,
    });
    const next = reader.next();
    const rejected = expect(next).rejects.toThrow("test cancel");
    await until(() => !first);
    controller.abort(Error("test cancel"));
    await rejected;
    await until(() => blocked.destroyed);
    await sleep(30);
    const retry = readFile({
      client: consumer,
      project_id,
      name,
      path: source,
      end: 10,
    });
    let bytes = 0;
    for await (const chunk of retry) bytes += chunk.length;
    expect(bytes).toBe(11);
  });

  it("closes a stream factory that completes after cancellation", async () => {
    await close({ project_id, name });
    let opened = false;
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stream = new PassThrough();
    await createServer({
      client: producer,
      project_id,
      name,
      createReadStream: async () => {
        opened = true;
        await delayed;
        return stream;
      },
    });
    const controller = new AbortController();
    const reader = readFile({
      client: consumer,
      project_id,
      name,
      path: source,
      signal: controller.signal,
    });
    const next = reader.next();
    const rejected = expect(next).rejects.toThrow("late cancel");
    await until(() => opened);
    controller.abort(Error("late cancel"));
    await rejected;
    release();
    await until(() => stream.destroyed);
  });

  it("terminates a stalled read on timeout without reporting an empty success", async () => {
    await close({ project_id, name });
    const stream = new PassThrough();
    await createServer({
      client: producer,
      project_id,
      name,
      createReadStream: () => stream,
    });
    const reader = readFile({
      client: consumer,
      project_id,
      name,
      path: source,
      maxWait: 150,
    });
    await expect(reader.next()).rejects.toThrow(/timed out|truncated/);
    await until(() => stream.destroyed);
  });

  it("early return cancels the sender without needing an AbortSignal", async () => {
    for await (const _chunk of readFile({
      client: consumer,
      project_id,
      name,
      path: source,
    })) {
      break;
    }
    await until(() => streams[0].destroyed);
    expect(streams[0].bytesRead).toBeLessThanOrEqual(2 * READ_CHUNK_BYTES);
  });

  it("caps project-wide read windows and releases them after cancellation", async () => {
    await close({ project_id, name });
    const blocked: PassThrough[] = [];
    await createServer({
      client: producer,
      project_id,
      name,
      maxActiveStreams: 128,
      createReadStream: () => {
        const stream = new PassThrough();
        blocked.push(stream);
        return stream;
      },
    });
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const pending = controllers.map((controller) =>
      readFile({
        client: consumer,
        project_id,
        name,
        path: source,
        signal: controller.signal,
      }).next(),
    );
    const settled = Promise.allSettled(pending);
    try {
      await until(() => blocked.length === 4);
      const overflow = readFile({
        client: consumer,
        project_id,
        name,
        path: source,
      });
      await expect(overflow.next()).rejects.toThrow("busy");
      // Bypass readFile's independent consumer cap to check producer admission
      // as well (the remote caller could be a different process).
      const remoteOverflow = await consumer.requestMany(
        projectSubject({ project_id, service: `files:read${name}` }),
        { path: source, fileReadProtocol: READ_PROTOCOL },
        { maxWait: 1000 },
      );
      try {
        expect((await remoteOverflow.next()).value?.headers?.error).toContain(
          "busy",
        );
      } finally {
        remoteOverflow.cancel();
      }
      expect(blocked).toHaveLength(4);
    } finally {
      controllers.forEach((controller) => controller.abort());
      await settled;
      await until(() => blocked.every((stream) => stream.destroyed));
    }
    await sleep(30);
    const retryController = new AbortController();
    const retry = readFile({
      client: consumer,
      project_id,
      name,
      path: source,
      signal: retryController.signal,
    }).next();
    const rejected = expect(retry).rejects.toThrow();
    await until(() => blocked.length === 5);
    retryController.abort();
    await rejected;
    await until(() => blocked[4].destroyed);
  });

  it.each([undefined, "legacy", "ack-v2"])(
    "rejects missing/unsupported protocol %s before opening any source",
    async (fileReadProtocol) => {
      const request = await consumer.requestMany(
        projectSubject({ project_id, service: `files:read${name}` }),
        { path: source, fileReadProtocol },
        { maxWait: 1000 },
      );
      try {
        const response = (await request.next()).value;
        expect(response?.headers?.code).toBe("file-read-protocol-required");
        expect(response?.headers?.error).toContain("refresh this browser tab");
        expect(streams).toHaveLength(0);
      } finally {
        request.cancel();
      }
    },
  );

  it("releases abandoned pre-handshake admission within the short server deadline", async () => {
    await close({ project_id, name });
    const opened = jest.fn((path, opts) => createReadStream(path, opts));
    await createServer({
      client: producer,
      project_id,
      name,
      maxActiveStreams: 1,
      createReadStream: opened,
    });
    const request = await consumer.requestMany(
      projectSubject({ project_id, service: `files:read${name}` }),
      {
        path: source,
        fileReadProtocol: READ_PROTOCOL,
        maxWait: 60 * 60 * 1000,
      },
      { maxWait: 60 * 60 * 1000 },
    );
    request.cancel();
    await sleep(50);
    await expect(
      readFile({ client: consumer, project_id, name, path: source }).next(),
    ).rejects.toThrow("busy");
    expect(opened).not.toHaveBeenCalled();
    await sleep(READ_HANDSHAKE_WAIT + 100);
    const retry = readFile({
      client: consumer,
      project_id,
      name,
      path: source,
      end: 0,
    });
    try {
      expect((await retry.next()).value).toHaveLength(1);
    } finally {
      await retry.return(undefined);
    }
  });

  it("rejects a malformed encoding without shutting down the shared reader", async () => {
    const request = await consumer.requestMany(
      projectSubject({ project_id, service: `files:read${name}` }),
      null,
      { raw: Buffer.from([0xc1]), maxWait: 1000 },
    );
    try {
      expect((await request.next()).value?.headers?.code).toBe(
        "file-read-protocol-required",
      );
    } finally {
      request.cancel();
    }
    const retry = readFile({
      client: consumer,
      project_id,
      name,
      path: source,
      end: 0,
    });
    try {
      expect((await retry.next()).value).toHaveLength(1);
    } finally {
      await retry.return(undefined);
    }
  });

  it("cancels before inbox readiness without dispatching a read", async () => {
    const readiness = jest
      .spyOn(consumer as any, "getInbox")
      .mockReturnValue(new Promise(() => {}));
    const publish = jest.spyOn(consumer, "publish");
    const controller = new AbortController();
    try {
      const pending = consumer.requestMany("not-dispatched", null, {
        signal: controller.signal,
      });
      controller.abort(Error("cancel setup"));
      await expect(pending).rejects.toThrow("cancel setup");
      expect(publish).not.toHaveBeenCalled();
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      readiness.mockRestore();
      publish.mockRestore();
    }
  });

  it("does not retry a publish after cancellation during interest discovery", async () => {
    let release!: () => void;
    const discovery = jest
      .spyOn(consumer, "waitForInterest")
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
    const publish = jest.spyOn(consumer as any, "_publish");
    const controller = new AbortController();
    try {
      const pending = consumer.requestMany("not-yet-served", null, {
        signal: controller.signal,
        waitForInterest: true,
      });
      const rejected = expect(pending).rejects.toThrow("cancel discovery");
      await until(() => !!release);
      controller.abort(Error("cancel discovery"));
      await rejected;
      release();
      await sleep(30);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      release?.();
      discovery.mockRestore();
      publish.mockRestore();
    }
  });

  it("cleans up its inbox subscription when initial publication fails", async () => {
    const inbox = await (consumer as any).getInbox();
    const before = inbox.eventNames().length;
    const publish = jest
      .spyOn(consumer, "publish")
      .mockRejectedValueOnce(Error("cannot publish"));
    const controller = new AbortController();
    try {
      await expect(
        consumer.requestMany("failed-publish", null, {
          signal: controller.signal,
        }),
      ).rejects.toThrow("cannot publish");
      expect(inbox.eventNames()).toHaveLength(before);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      publish.mockRestore();
    }
  });

  it("recovers when the browser disconnects while HTTP is waiting for drain", async () => {
    let handler: Promise<void> | undefined;
    let response;
    const accounting = jest.fn(async () => {});
    const http = createHttpServer((req, res) => {
      response = res;
      handler = handleFileDownload({
        req,
        res,
        client: consumer,
        readServiceName: name,
        onExplicitDownloadComplete: accounting,
        url: `/${project_id}/files${source}?download`,
      });
    });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const port = (http.address() as { port: number }).port;
    const request = get(`http://127.0.0.1:${port}/`, (incoming) =>
      incoming.pause(),
    );
    request.on("error", () => {});
    try {
      await until(() => !!response?.listenerCount("drain"));
      await sleep(700);
      expect(streams[0].bytesRead).toBeLessThanOrEqual(2 * READ_CHUNK_BYTES);
      request.destroy();
      await until(() => response.destroyed && streams[0].destroyed);
      await handler;
      expect(response.listenerCount("drain")).toBe(0);
      expect(accounting).toHaveBeenCalledTimes(1);
      expect(accounting).toHaveBeenCalledWith(
        expect.objectContaining({ partial: true, bytes: READ_CHUNK_BYTES }),
      );
    } finally {
      request.destroy();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await handler;
    }
  });
});
