import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { PERSONAL_LIBRARY_MAX_PIN_BYTES } from "@cocalc/util/personal-library";
import { personalLibraryStore } from "./personal-library-store";

jest.mock("@cocalc/server/agents/personal-rehome", () => ({
  assertPersonalAccountAuthority: jest.fn().mockResolvedValue(undefined),
}));

const account_id = randomUUID();
const project_id = randomUUID();
const pin = (artifact: string, path = "/chat.chat") =>
  JSON.stringify([project_id, path, "thread", artifact]);

beforeAll(async () => {
  await initEphemeralDatabase({});
}, 30000);
beforeEach(async () => {
  await getPool().query(
    "TRUNCATE personal_library_pins,personal_library_aliases,personal_library_controls CASCADE",
  );
});
afterAll(async () => {
  await getPool().end();
});

test("pins append, unpin, and reorder only visible slots", async () => {
  const first = pin("first");
  const hidden = pin("hidden");
  const last = pin("last");
  for (const pin_key of [first, hidden, last])
    await personalLibraryStore.setPinned({ account_id, pin_key, pinned: true });
  expect(
    (
      await personalLibraryStore.movePinned({
        account_id,
        visible: [first, last],
        pin_key: last,
        index: 0,
      })
    ).pins,
  ).toEqual([last, hidden, first]);
  await personalLibraryStore.setPinned({
    account_id,
    pin_key: hidden,
    pinned: false,
  });
  const added = pin("new");
  expect(
    (
      await personalLibraryStore.setPinned({
        account_id,
        pin_key: added,
        pinned: true,
      })
    ).pins,
  ).toEqual([last, first, added]);
  const ranks = (
    await getPool().query(
      "SELECT rank FROM personal_library_pins WHERE account_id=$1 ORDER BY rank",
      [account_id],
    )
  ).rows.map((row) => Number(row.rank));
  expect(ranks).toEqual([0, 2, 3]);
});

test("pin mutations enforce both row and serialized-byte budgets", async () => {
  for (let index = 0; index < 100; index++)
    await personalLibraryStore.setPinned({
      account_id,
      pin_key: pin(`artifact-${index}`),
      pinned: true,
    });
  await expect(
    personalLibraryStore.setPinned({
      account_id,
      pin_key: pin("overflow"),
      pinned: true,
    }),
  ).rejects.toThrow("Artifact pin limit reached");
  await getPool().query(
    "DELETE FROM personal_library_pins WHERE account_id=$1",
    [account_id],
  );
  const path = `/${"x".repeat(4000)}.chat`;
  let accepted = 0;
  for (; accepted < 100; accepted++) {
    try {
      await personalLibraryStore.setPinned({
        account_id,
        pin_key: pin(`large-${accepted}`, path),
        pinned: true,
      });
    } catch (err) {
      expect(String(err)).toContain("Artifact pin limit reached");
      break;
    }
  }
  expect(accepted).toBeLessThan(100);
  const pins = (await personalLibraryStore.list({ account_id })).pins;
  expect(pins).toHaveLength(accepted);
  expect(
    pins.reduce((bytes, key) => bytes + Buffer.byteLength(key), 0),
  ).toBeLessThanOrEqual(PERSONAL_LIBRARY_MAX_PIN_BYTES);
});
