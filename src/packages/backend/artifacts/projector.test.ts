import { ArtifactCatalogJournal } from "./journal";
import { ArtifactCatalogProjector } from "./projector";
import type { ArtifactCatalogSnapshot } from "@cocalc/util/artifact-catalog";

const source = {
  project_id: "11111111-1111-4111-8111-111111111111",
  chat_path: "/home/user/a.chat",
};
let journal: ArtifactCatalogJournal;
beforeEach(() => {
  journal = new ArtifactCatalogJournal(":memory:");
  journal.register(source, "epoch");
});
afterEach(() => journal.close());

test("lost acknowledgement retries the exact persisted payload", async () => {
  let now = 1;
  const read = jest.fn(async () => []);
  const send = jest
    .fn()
    .mockRejectedValueOnce(Error("response lost"))
    .mockResolvedValue(undefined);
  const onError = jest.fn();
  const worker = new ArtifactCatalogProjector({
    journal,
    read,
    send,
    onError,
    now: () => now,
  });
  expect(await worker.runOnce()).toEqual({ scanned: 1, delivered: 0 });
  await worker.runOnce();
  expect(send).toHaveBeenCalledTimes(1);
  now += 2000;
  expect(await worker.runOnce()).toEqual({ scanned: 0, delivered: 1 });
  expect(send.mock.calls[0][0]).toEqual(send.mock.calls[1][0]);
  expect(read).toHaveBeenCalledTimes(1);
  expect(journal.scans()).toEqual([]);
});

test("parse/access failure never publishes an empty replacement", async () => {
  const send = jest.fn();
  const onError = jest.fn();
  const worker = new ArtifactCatalogProjector({
    journal,
    read: async () => {
      throw Error("EACCES");
    },
    send,
    onError,
  });
  await worker.runOnce();
  expect(onError).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  expect(journal.scans(32, Date.now() + 60000)).toHaveLength(1);
});

test("overlapping passes do not multiply outstanding reads", async () => {
  let resolve!: (value: []) => void;
  const read = jest.fn(
    () =>
      new Promise<[]>((done) => {
        resolve = done;
      }),
  );
  const worker = new ArtifactCatalogProjector({
    journal,
    read,
    send: async () => {},
    onError: jest.fn(),
  });
  const first = worker.runOnce();
  expect(await worker.runOnce()).toEqual({ scanned: 0, delivered: 0 });
  resolve([]);
  await first;
  expect(read).toHaveBeenCalledTimes(1);
});

test("stop during a source read leaves work durable for the next service", async () => {
  let resolve!: (value: []) => void;
  const send = jest.fn();
  const worker = new ArtifactCatalogProjector({
    journal,
    read: () =>
      new Promise<[]>((done) => {
        resolve = done;
      }),
    send,
    onError: jest.fn(),
  });
  const pass = worker.runOnce();
  worker.stop();
  resolve([]);
  await pass;
  expect(send).not.toHaveBeenCalled();
  expect(journal.scans()).toHaveLength(1);
});

test("a failing source does not starve later sources in size-one passes", async () => {
  journal.register({ ...source, chat_path: "/home/user/b.chat" }, "epoch");
  const send = jest.fn(async (_snapshot: ArtifactCatalogSnapshot) => {});
  const worker = new ArtifactCatalogProjector({
    journal,
    read: async (source) => {
      if (source.chat_path.endsWith("a.chat")) throw Error("bad source");
      return [];
    },
    send,
    onError: jest.fn(),
  });
  await worker.runOnce(1);
  expect(await worker.runOnce(1)).toEqual({ scanned: 1, delivered: 1 });
  expect(send.mock.calls[0][0].chat_path).toBe("/home/user/b.chat");
});
