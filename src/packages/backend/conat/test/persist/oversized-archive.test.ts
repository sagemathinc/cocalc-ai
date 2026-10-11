/*
When a stream is refused because it holds a message too large to read, the
persist server keeps a copy of its database next to it before the history is
reset, at most one copy per database.

pnpm test ./oversized-archive.test.ts
*/

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  before,
  after,
  connect,
  tempDir,
} from "@cocalc/backend/conat/test/setup";
import { stream } from "@cocalc/conat/persist/client";
import { messageData } from "@cocalc/conat/core/client";

beforeAll(before);
afterAll(async () => {
  delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
  await after();
});

jest.setTimeout(30000);

async function findFiles(dir: string, match: (name: string) => boolean) {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findFiles(path, match)));
    } else if (match(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

describe("archiving a stream refused for an oversized message", () => {
  it("keeps one copy, with all messages, however often the stream is refused", async () => {
    const name = `oversized-archive-${Math.random()}`;
    const s = stream({
      client: connect(),
      user: { hub_id: "x" },
      storage: { path: `hub/${name}` },
    });
    await s.set({ messageData: messageData("small") });
    await s.set({ messageData: messageData("x".repeat(500_000)) });
    process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES = "100000";

    for (let i = 0; i < 3; i++) {
      await expect(s.getAll({ timeout: 5000 })).rejects.toMatchObject({
        code: 413,
      });
    }
    const archives = await findFiles(tempDir, (file) =>
      file.startsWith(`${name}.db.oversized-`),
    );
    expect(archives).toHaveLength(1);
    expect(archives[0].endsWith(".tmp")).toBe(false);

    const copy = new DatabaseSync(archives[0], { readOnly: true });
    try {
      expect(
        (copy.prepare("SELECT COUNT(*) AS n FROM messages").get() as any).n,
      ).toBe(2);
    } finally {
      copy.close();
    }
    delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
    s.close();
  });
});
