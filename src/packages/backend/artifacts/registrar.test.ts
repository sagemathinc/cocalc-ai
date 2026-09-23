import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactCatalogJournal } from "./journal";
import { ArtifactCatalogRegistrar } from "./registrar";

const source = {
  project_id: "11111111-1111-4111-8111-111111111111",
  chat_path: "/home/user/test.chat",
};
let directory: string;
let journal: ArtifactCatalogJournal;
let now: number;
const state = jest.fn();
const register = jest.fn();
const onError = jest.fn();
const worker = () =>
  new ArtifactCatalogRegistrar({
    journal,
    writerState: state,
    register,
    onError,
    now: () => now,
  });
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "artifact-registrar-"));
  journal = new ArtifactCatalogJournal(join(directory, "journal.sqlite"));
  now = 1000;
  state.mockReset().mockResolvedValue(null);
  register.mockReset().mockResolvedValue({ epoch: "issued" });
  onError.mockReset();
  journal.finishWrite(journal.beginWrite(source));
});
afterEach(() => {
  journal.close();
  rmSync(directory, { recursive: true, force: true });
});

test("first offline write registers asynchronously before becoming scannable", async () => {
  expect(journal.scans()).toEqual([]);
  const registration = journal.pendingRegistrations()[0];
  expect(await worker().runOnce()).toBe(1);
  expect(register).toHaveBeenCalledWith({
    ...registration,
    expected_epoch: null,
  });
  expect(journal.scans()[0].epoch).toBe("issued");
  expect(journal.pendingRegistrations()).toEqual([]);
});

test("an already committed matching registration is recovered without rotation", async () => {
  const pending = journal.pendingRegistrations()[0];
  state.mockResolvedValue({
    epoch: "already-issued",
    registration_id: pending.registration_id,
  });
  expect(await worker().runOnce()).toBe(1);
  expect(register).not.toHaveBeenCalled();
  expect(journal.scans()[0].epoch).toBe("already-issued");
});

test("lost response retries the identical durable CAS after a process restart", async () => {
  state.mockResolvedValue({ epoch: "previous", registration_id: "other" });
  register.mockRejectedValueOnce(Error("response lost"));
  await worker().runOnce();
  const request = register.mock.calls[0][0];
  expect(request.expected_epoch).toBe("previous");
  journal.close();
  journal = new ArtifactCatalogJournal(join(directory, "journal.sqlite"));
  expect(await worker().runOnce()).toBe(0);
  now += 1000;
  expect(await worker().runOnce()).toBe(1);
  expect(register.mock.calls[1][0]).toEqual(request);
  expect(state).toHaveBeenCalledTimes(1);
});

test("CAS conflict never rereads and replaces a newer writer", async () => {
  register.mockRejectedValue(Error("epoch changed"));
  await worker().runOnce();
  const request = register.mock.calls[0][0];
  state.mockResolvedValue({ epoch: "newer-writer", registration_id: "newer" });
  now += 1000;
  await worker().runOnce();
  expect(register.mock.calls[1][0]).toEqual(request);
  expect(state).toHaveBeenCalledTimes(1);
  expect(journal.scans()).toEqual([]);
});

test("failed lookups back off without inventing a registration base", async () => {
  state.mockRejectedValueOnce(Error("offline"));
  await worker().runOnce();
  expect(journal.pendingRegistrations(16, now)).toEqual([]);
  expect(register).not.toHaveBeenCalled();
  now += 1000;
  state.mockResolvedValue({ epoch: "existing", registration_id: "other" });
  await worker().runOnce();
  expect(register.mock.calls[0][0].expected_epoch).toBe("existing");
});

test("a write in flight delays local activation without changing the CAS", async () => {
  const token = journal.beginWrite(source);
  await worker().runOnce();
  expect(onError.mock.calls[0][1].message).toContain("being written");
  expect(journal.scans()).toEqual([]);
  journal.finishWrite(token);
  now += 1000;
  await worker().runOnce();
  expect(register.mock.calls[1][0]).toEqual(register.mock.calls[0][0]);
  expect(journal.scans()).toHaveLength(1);
});

test("stop and repeated passes do not multiply in-flight lookups", async () => {
  let release!: (value: null) => void;
  state.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const registrar = worker();
  const running = registrar.runOnce();
  expect(await registrar.runOnce()).toBe(0);
  registrar.stop();
  release(null);
  expect(await running).toBe(0);
  expect(register).not.toHaveBeenCalled();
  expect(await registrar.runOnce()).toBe(0);
});

test("bounded passes skip deferred failures and make progress on other sources", async () => {
  state.mockRejectedValueOnce(Error("unavailable"));
  await worker().runOnce(1);
  journal.finishWrite(
    journal.beginWrite({ ...source, chat_path: "/home/user/z.chat" }),
  );
  expect(await worker().runOnce(1)).toBe(1);
  expect(journal.scans()[0].chat_path).toBe("/home/user/z.chat");
});
