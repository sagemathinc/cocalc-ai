import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import { init } from "../core/server";
import { createServer, close, writeFile } from "./write";

it("bounds a blocked real Conat copy and never reports premature success", async () => {
  const server = init({ port: 0, autoscanInterval: 0 });
  if (server.state !== "ready") await once(server, "ready");
  const sender = server.client({ noCache: true });
  const receiver = server.client({ noCache: true });
  const project_id = "00000000-5000-4000-8000-000000000099";
  const sink = new Writable({ highWaterMark: 1, write() {} });
  const chunk = Buffer.alloc(4 * 1024 * 1024);
  const source = Readable.from([chunk, chunk, chunk, chunk]);
  let succeeded = false;
  let failure: Promise<void> | undefined;
  try {
    await createServer({
      client: receiver,
      project_id,
      createWriteStream: () => sink,
    });
    const copy = writeFile({
      client: sender,
      project_id,
      path: "/blocked",
      stream: source,
      maxWait: 10000,
    });
    failure = expect(
      copy.then((result) => {
        succeeded = true;
        return result;
      }),
    ).rejects.toThrow("destination closed");
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(sink.writableLength).toBe(chunk.length);
    expect(sink.writableFinished).toBe(false);
    expect(succeeded).toBe(false);
    sink.destroy();
    await failure;
    for (let i = 0; i < 100 && !source.destroyed; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(source.destroyed).toBe(true);
  } finally {
    sink.destroy();
    source.destroy();
    await failure;
    await close({ project_id });
    sender.close();
    receiver.close();
    await server.close();
  }
}, 15000);
