import { randomUUID } from "node:crypto";
import { dkv } from "@cocalc/conat/sync/dkv";
import { akv } from "@cocalc/conat/sync/akv";
import { before, after, client, wait } from "@cocalc/backend/conat/test/setup";
import { accountProjectPins } from "./project-pins";

beforeAll(before);
afterAll(after);
test("real account DKV favorites and the server pin adapter read each other's durable writes", async () => {
  const account_id = randomUUID();
  const first = randomUUID();
  const second = randomUUID();
  const favorites = await dkv<string[]>({
    client,
    account_id,
    name: "bookmarks",
  });
  const pins = accountProjectPins(client, account_id);
  try {
    const revision = await pins.revision();
    expect(await pins.read()).toEqual([]);
    favorites.set("projects", [first]);
    await favorites.save();
    expect(await pins.revision()).not.toEqual(revision);
    expect(await pins.read()).toEqual([first]);
    await pins.set(second, true);
    await wait({
      until: () => favorites.get("projects")?.join() === [second, first].join(),
    });
    await pins.set(first, false);
    await wait({ until: () => favorites.get("projects")?.join() === second });
    expect(await accountProjectPins(client, account_id).read()).toEqual([
      second,
    ]);
    expect(await accountProjectPins(client, randomUUID()).read()).toEqual([]);
    favorites.delete("projects");
    await favorites.save();
    await pins.set(first, true);
    expect(await pins.read()).toEqual([first]);
    const direct = akv<string[]>({ client, account_id, name: "bookmarks" });
    try {
      expect(await direct.get("projects")).toEqual([first]);
    } finally {
      direct.close();
    }
  } finally {
    favorites.close();
  }
}, 30000);
