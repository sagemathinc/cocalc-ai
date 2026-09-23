import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactCatalogJournal } from "./journal";

const source = {
  project_id: "11111111-1111-4111-8111-111111111111",
  chat_path: "/home/user/test.chat",
};
let directory: string;
let journal: ArtifactCatalogJournal;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "artifact-journal-"));
  journal = new ArtifactCatalogJournal(join(directory, "journal.sqlite"));
  journal.register(source, "owner-issued-epoch");
});
afterEach(() => {
  journal.close();
  rmSync(directory, { recursive: true, force: true });
});

test("a committed write intent survives a crash before or after the file write", () => {
  journal.beginWrite(source);
  expect(journal.scans()).toEqual([]);
  journal.close();
  journal = new ArtifactCatalogJournal(join(directory, "journal.sqlite"));
  expect(journal.scans()).toEqual([]);
  journal.recoverInterruptedWrites();
  expect(journal.scans()).toHaveLength(1);
  expect(journal.prepare(journal.scans()[0], [])).toBe(true);
  expect(journal.deliveries()).toHaveLength(1);
});

test("failed writes remain dirty, and overlapping writes all have to finish", async () => {
  const token = journal.beginWrite(source);
  await expect(
    journal.write(source, async () => {
      throw Error("disk full");
    }),
  ).rejects.toThrow("disk full");
  expect(journal.scans()).toEqual([]);
  journal.finishWrite(token);
  expect(journal.scans()).toHaveLength(1);
});

test("rejects a scan racing any file mutation", () => {
  const scan = journal.scans()[0];
  const token = journal.beginWrite(source);
  expect(journal.prepare(scan, [])).toBe(false);
  journal.finishWrite(token);
  expect(journal.prepare(scan, [])).toBe(false);
  expect(journal.prepare(journal.scans()[0], [])).toBe(true);
});

test("delivery is immutable across restart and acknowledgement is idempotent", () => {
  journal.prepare(journal.scans()[0], []);
  const delivery = journal.deliveries()[0];
  journal.close();
  journal = new ArtifactCatalogJournal(join(directory, "journal.sqlite"));
  expect(journal.deliveries()).toEqual([delivery]);
  expect(journal.scans()).toEqual([]);
  journal.acknowledge(delivery);
  journal.acknowledge(delivery);
  expect(journal.scans()).toEqual([]);
  expect(journal.deliveries()).toEqual([]);
});

test("late acknowledgements cannot erase a newer mutation or delivery", () => {
  journal.prepare(journal.scans()[0], []);
  const old = journal.deliveries()[0];
  const token = journal.beginWrite(source);
  expect(journal.deliveries()).toEqual([]);
  journal.acknowledge(old);
  journal.finishWrite(token);
  journal.prepare(journal.scans()[0], []);
  const current = journal.deliveries()[0];
  expect(current.sequence).toBeGreaterThan(old.sequence);
  journal.acknowledge(old);
  expect(journal.deliveries()).toEqual([current]);
});

test("epoch changes fence old scans and acknowledgements", () => {
  const scan = journal.scans()[0];
  journal.prepare(scan, []);
  const old = journal.deliveries()[0];
  journal.register(source, "new-owner-epoch");
  expect(journal.prepare(scan, [])).toBe(false);
  journal.prepare(journal.scans()[0], []);
  journal.acknowledge(old);
  expect(journal.deliveries()[0].epoch).toBe("new-owner-epoch");
});

test("invalid snapshots do not consume a delivery sequence", () => {
  const scan = journal.scans()[0];
  expect(() => journal.prepare(scan, [{} as any])).toThrow();
  expect(journal.deliveries()).toEqual([]);
  journal.prepare(scan, []);
  expect(journal.deliveries()[0].sequence).toBe(1);
});

test("identical source registration does not requeue acknowledged sources", () => {
  journal.prepare(journal.scans()[0], []);
  journal.acknowledge(journal.deliveries()[0]);
  journal.register(source, "owner-issued-epoch");
  expect(journal.scans()).toEqual([]);
});

test("assignment recovery persists a fresh CAS and ignores late failures from old writers", () => {
  journal.prepare(journal.scans()[0], []);
  const old = journal.deliveries()[0];
  const token = journal.beginWrite(source);
  expect(journal.requeueRegistration(old, "foreign-host-epoch")).toBe(true);
  const pending = journal.pendingRegistrations()[0];
  expect(journal.registrationBase(pending)).toEqual({
    expected_epoch: "foreign-host-epoch",
  });
  expect(journal.deliveries()).toEqual([]);
  expect(() => journal.register(source, "returned-host-epoch")).toThrow(
    "being written",
  );
  journal.finishWrite(token);
  journal.close();
  journal = new ArtifactCatalogJournal(join(directory, "journal.sqlite"));
  expect(journal.pendingRegistrations()).toEqual([pending]);
  expect(journal.registrationBase(pending)).toEqual({
    expected_epoch: "foreign-host-epoch",
  });
  journal.register(source, "returned-host-epoch");
  expect(journal.requeueRegistration(old, "late-epoch")).toBe(false);
  expect(journal.requeueRegistration(pending, "late-epoch")).toBe(false);
  journal.acknowledge(old);
  expect(journal.scans()[0].epoch).toBe("returned-host-epoch");
  expect(journal.prepare(journal.scans()[0], [])).toBe(true);
  expect(journal.deliveries()[0].sequence).toBe(1);
});

test("first writes need no hub; registration retry identity survives restart", () => {
  const next = { ...source, chat_path: "/home/user/new.chat" };
  const token = journal.beginWrite(next);
  journal.finishWrite(token);
  const pending = journal.pendingRegistrations();
  expect(pending).toHaveLength(1);
  expect(journal.scans().some((row) => row.chat_path === next.chat_path)).toBe(
    false,
  );
  journal.close();
  journal = new ArtifactCatalogJournal(join(directory, "journal.sqlite"));
  expect(journal.pendingRegistrations()).toEqual(pending);
  journal.register(next, "owner-issued-new-epoch");
  expect(journal.pendingRegistrations()).toEqual([]);
  expect(journal.scans().some((row) => row.chat_path === next.chat_path)).toBe(
    true,
  );
});
