/*
A closed client must fail cleanly, not with a TypeError: close() deletes
client.options, and code that runs late (an info event, an inbox request)
used to read options.disableInbox from it. In browsers that surfaced as
"Cannot read properties of undefined (reading 'disableInbox')".

pnpm test `pwd`/closed-client.test.ts
*/

import { before, after, connect } from "@cocalc/backend/conat/test/setup";

beforeAll(before);
afterAll(after);

describe("a closed conat client", () => {
  it("rejects inbox requests with 'closed', not a TypeError", async () => {
    const client = connect();
    await client.waitUntilConnected();
    client.close();
    await expect(client.socketInboxSubject()).rejects.toThrow("closed");
  });

  it("ignores an info event that arrives after close", async () => {
    const client = connect();
    await client.waitUntilConnected();
    const handlers = client.conn.listeners("info") as Function[];
    expect(handlers.length).toBeGreaterThan(0);
    client.close();
    for (const handler of handlers) {
      expect(() => handler({}, () => {})).not.toThrow();
    }
  });
});
