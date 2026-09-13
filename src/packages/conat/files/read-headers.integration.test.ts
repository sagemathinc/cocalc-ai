import { once } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { init, type ConatServer } from "../core/server";
import type { Client } from "../core/client";
import {
  MAX_MESSAGE_HEADER_BYTES,
  MAX_MESSAGE_HEADER_ENTRIES,
} from "../core/message-headers";
import { createServer, close, readFile } from "./read";
import { projectSubject } from "../names";

const project_id = "00000000-1000-4000-8000-000000000088";
const subject = projectSubject({ project_id, service: "files:read" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await sleep(10);
  }
  throw Error("condition timed out");
}

describe("router header rejection leaves readers available", () => {
  let server: ConatServer;
  let producer: Client;
  let consumer: Client;
  let open: jest.Mock;
  beforeAll(async () => {
    server = init({ port: 0, autoscanInterval: 0 });
    if (server.state !== "ready") await once(server, "ready");
    producer = server.client({ noCache: true });
    consumer = server.client({ noCache: true });
    await consumer.waitUntilSignedIn();
  });
  beforeEach(async () => {
    open = jest.fn(() => Readable.from([Buffer.from("ok")]));
    await createServer({
      client: producer,
      project_id,
      createReadStream: open,
      maxActiveStreams: 1,
    });
  });
  afterEach(async () => {
    await close({ project_id });
  });
  afterAll(async () => {
    producer.close();
    consumer.close();
    await server.close();
  });

  async function assertHealthy() {
    const chunks: Buffer[] = [];
    for await (const chunk of readFile({
      client: consumer,
      project_id,
      path: "/ok",
    }))
      chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("ok");
  }

  it.each([
    { label: "string", headers: "not a record" },
    { label: "array", headers: ["value"] },
    { label: "binary", headers: Buffer.alloc(8) },
    { label: "object reply", headers: { "CN-Reply": {} } },
    { label: "wildcard reply", headers: { "CN-Reply": "INBOX.*" } },
    {
      label: "header bytes",
      headers: { value: "x".repeat(MAX_MESSAGE_HEADER_BYTES) },
    },
    {
      label: "header entries",
      headers: Object.fromEntries(
        Array.from({ length: MAX_MESSAGE_HEADER_ENTRIES + 1 }, (_, i) => [
          `k${i}`,
          0,
        ]),
      ),
    },
  ])("rejects $label with 400 before reader delivery", async ({ headers }) => {
    await expect(
      consumer.publish(
        subject,
        { path: "/unused" },
        { headers: headers as any },
      ),
    ).rejects.toMatchObject({ code: 400 });
    expect(open).not.toHaveBeenCalled();
    await assertHealthy();
  });

  it("rejects invalid replies while admitted reads are active, then recovers capacity", async () => {
    const blocked = new PassThrough();
    open.mockReturnValueOnce(blocked);
    const controller = new AbortController();
    const reader = readFile({
      client: consumer,
      project_id,
      path: "/waiting",
      signal: controller.signal,
    });
    const next = reader.next().catch((err) => err);
    try {
      await until(() => open.mock.calls.length === 1);
      await expect(
        consumer.publish(
          subject,
          { fileReadProtocol: "ack-v1" },
          {
            headers: { "CN-Reply": "invalid reply" },
          },
        ),
      ).rejects.toMatchObject({ code: 400 });
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      await next;
      await reader.return(undefined);
    }
    await until(() => blocked.destroyed);
    await sleep(30);
    await assertHealthy();
  });

  it("preserves a server rejection when publication has no timeout", async () => {
    await expect(
      consumer.publish(subject, null, {
        timeout: 0,
        headers: { "CN-Reply": "" },
      }),
    ).rejects.toMatchObject({ code: 400 });
    expect(open).not.toHaveBeenCalled();
    await assertHealthy();
  });
});
