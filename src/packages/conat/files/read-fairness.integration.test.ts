import { once } from "node:events";
import { PassThrough } from "node:stream";
import { init } from "../core/server";
import { createServer, close, readFile } from "./read";
import { FILE_READ_PRINCIPAL_HEADER } from "./read-principal";
import { projectSubject } from "../names";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
jest.setTimeout(15000);
async function until(done: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (done()) return;
    await sleep(10);
  }
  throw Error("condition timed out");
}

it("isolates an account across sockets/projects and ignores forged admission identity", async () => {
  // This test's authenticator stands in for the real verified-cookie/token
  // authenticator. Stamping must use its result, not the publish payload.
  const server = init({
    port: 0,
    autoscanInterval: 0,
    getUser: async (socket) => socket.handshake.auth,
  });
  if (server.state !== "ready") await once(server, "ready");
  const producer = server.client({ noCache: true, auth: { hub_id: "system" } });
  const a = server.client({ noCache: true, auth: { account_id: "alice" } });
  const a2 = server.client({ noCache: true, auth: { account_id: "alice" } });
  const b = server.client({ noCache: true, auth: { account_id: "bob" } });
  const projects = Array.from(
    { length: 9 },
    (_, i) => `00000000-6000-4000-8000-${String(i).padStart(12, "0")}`,
  );
  const streams: PassThrough[] = [];
  const controllers: AbortController[] = [];
  const pending: Promise<any>[] = [];
  try {
    for (const project_id of projects)
      await createServer({
        client: producer,
        project_id,
        createReadStream: () => {
          const stream = new PassThrough();
          streams.push(stream);
          return stream;
        },
      });
    await a.waitUntilSignedIn();
    for (const project_id of projects.slice(0, 8)) {
      const controller = new AbortController();
      controllers.push(controller);
      pending.push(
        readFile({
          client: a,
          project_id,
          path: "/waiting",
          signal: controller.signal,
        })
          .next()
          .catch((err) => err),
      );
    }
    await until(() => streams.length === 8);
    const denied = await a2.requestMany(
      projectSubject({ project_id: projects[8], service: "files:read" }),
      { path: "/forged", account_id: "mallory", fileReadProtocol: "ack-v1" },
      {
        maxWait: 1000,
        headers: { [FILE_READ_PRINCIPAL_HEADER]: "account:mallory" },
      },
    );
    try {
      expect((await denied.next()).value?.headers?.error).toContain("busy");
    } finally {
      denied.cancel();
    }
    expect(streams).toHaveLength(8);
    const controller = new AbortController();
    controllers.push(controller);
    pending.push(
      readFile({
        client: b,
        project_id: projects[8],
        path: "/allowed",
        signal: controller.signal,
      })
        .next()
        .catch((err) => err),
    );
    await until(() => streams.length === 9);
  } finally {
    controllers.forEach((c) => c.abort());
    await Promise.all(pending);
    await until(() => streams.every((s) => s.destroyed));
    for (const project_id of projects) await close({ project_id });
    producer.close();
    a.close();
    a2.close();
    b.close();
    await server.close();
  }
});
