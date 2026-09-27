import { randomUUID } from "node:crypto";
import { LiteCollaborators } from "./index";

const account_id = randomUUID();
const project_id = randomUUID();
let enabled = true;
let favorites: string[];
let store: LiteCollaborators;
const pins = {
  revision: jest.fn(async () => favorites.join(",")),
  read: jest.fn(async () => favorites),
  set: jest.fn(async (id, pinned) => {
    favorites = pinned ? [id] : [];
  }),
};
beforeEach(() => {
  enabled = true;
  favorites = [];
  jest.clearAllMocks();
  store = new LiteCollaborators({
    filename: ":memory:",
    account_id,
    project_id,
    isEnabled: () => enabled,
    project_title: "Geometry",
    projectPins: pins,
  });
});
afterEach(() => store.close());
test("recent and pinned project views reuse existing favorites and combine filters", async () => {
  expect(
    (await store.api.listProjects({ account_id, view: "recent" })).items,
  ).toEqual([expect.objectContaining({ project_id, pinned: false })]);
  expect(
    (await store.api.listProjects({ account_id, view: "pinned" })).items,
  ).toEqual([]);
  await expect(
    store.api.setProjectPinned({ account_id, project_id, pinned: true }),
  ).resolves.toEqual({ pinned: true });
  expect(
    (
      await store.api.listProjects({
        account_id,
        view: "pinned",
        search: "geo",
        person_id: account_id,
      })
    ).items,
  ).toHaveLength(1);
  expect(
    (
      await store.api.listProjects({
        account_id,
        view: "pinned",
        search: "other",
      })
    ).items,
  ).toEqual([]);
  expect(
    (
      await store.api.listProjects({
        account_id,
        view: "pinned",
        person_id: "stranger",
      })
    ).items,
  ).toEqual([]);
  // A legacy favorites write is reflected without enrolling new personal state.
  favorites = [];
  expect(
    (await store.api.listProjects({ account_id, view: "pinned" })).items,
  ).toEqual([]);
});
test("pin changes invalidate Lite revisions and never create a room", async () => {
  const { revision } = await store.api.check({ account_id });
  await store.api.setProjectPinned({ account_id, project_id, pinned: true });
  expect((await store.api.check({ account_id, since: revision })).reset).toBe(
    true,
  );
  expect(await store.registeredRoom({ account_id, project_id })).toBeNull();
});

test("legacy favorites writes invalidate account revision without a directory mutation", async () => {
  const page = await store.api.listProjects({ account_id });
  expect(
    (await store.api.check({ account_id, since: page.revision })).reset,
  ).toBe(false);
  favorites = [project_id];
  expect(
    (await store.api.check({ account_id, since: page.revision })).reset,
  ).toBe(true);
  expect(pins.set).not.toHaveBeenCalled();
});
test("foreign account, project, disabled flag and malformed pin requests do not touch favorites", async () => {
  for (const opts of [
    { account_id: randomUUID(), project_id, pinned: true },
    { account_id, project_id: randomUUID(), pinned: true },
    { account_id, project_id, pinned: "true" as any },
  ])
    await expect(store.api.setProjectPinned(opts)).rejects.toThrow();
  enabled = false;
  await expect(
    store.api.setProjectPinned({ account_id, project_id, pinned: true }),
  ).rejects.toThrow();
  await expect(
    store.api.listProjects({ account_id, view: "pinned" }),
  ).rejects.toThrow();
  expect(pins.set).not.toHaveBeenCalled();
  expect(pins.read).not.toHaveBeenCalled();
});
test("invalid project view and cursors reject instead of falling back to recent", async () => {
  await expect(
    store.api.listProjects({ account_id, view: "all" as any }),
  ).rejects.toThrow("view");
  await expect(
    store.api.listProjects({ account_id, view: "pinned", after: "foreign" }),
  ).rejects.toThrow("cursor");
  expect(pins.read).not.toHaveBeenCalled();
});
