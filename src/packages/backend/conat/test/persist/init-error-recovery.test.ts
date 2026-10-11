/*
A persist stream whose storage fails to open, e.g., because the project hit its
disk quota, must recover once storage works again.  It used to stay broken for
the life of the client: the server replayed the first open error on every later
request, and the shared client never reconnected.

pnpm test ./init-error-recovery.test.ts
*/

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  before,
  after,
  connect,
  tempDir,
  wait,
} from "@cocalc/backend/conat/test/setup";
import { stream } from "@cocalc/conat/persist/client";
import { messageData } from "@cocalc/conat/core/client";

beforeAll(before);
afterAll(after);

jest.setTimeout(20000);

describe("persist stream recovers after its storage fails to open", () => {
  it("fails while the database path is unusable, then recovers", async () => {
    const path = "hub/init-error-recovery";
    // A directory where the sqlite file belongs makes every open fail.
    const blocker = join(tempDir, "local", `${path}.db`);
    await mkdir(blocker, { recursive: true });

    const client = connect();
    const options = {
      client,
      user: { hub_id: "x" },
      storage: { path },
    };
    // Two holders of the same cached client, like two turns of an agent
    // writing the same activity log.
    const first = stream(options);
    const second = stream(options);
    expect(second).toBe(first);
    first.on("error", () => {});

    await expect(
      first.set({ key: "a", messageData: messageData("one") }),
    ).rejects.toThrow();

    await rm(blocker, { recursive: true, force: true });

    await wait({
      until: async () => {
        try {
          await first.set({ key: "a", messageData: messageData("one") });
          return true;
        } catch {
          return false;
        }
      },
    });
    expect((await first.get({ key: "a" })).data).toBe("one");

    // The open failure must not have dropped a reference that a holder owns:
    // after one holder closes, the other can still write.
    first.close();
    await second.set({ key: "b", messageData: messageData("two") });
    expect((await second.get({ key: "b" })).data).toBe("two");
    second.close();
  });
});
