import { mkdtemp, rm, writeFile, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  saveClaudeControllerJournal,
  recoverClaudeControllerJournal,
  listClaudeControllerJournals,
} from "./claude-controller-journal";
import { packClaudeSubscriptionBundle } from "./claude-subscription-home";
import {
  manageClaudeControllerOwnership,
  syncClaudeSubscriptionCredential,
} from "./claude-subscription-registry";

jest.mock("./claude-subscription-registry", () => ({
  manageClaudeControllerOwnership: jest.fn(),
  syncClaudeSubscriptionCredential: jest.fn(),
}));
const manage = jest.mocked(manageClaudeControllerOwnership);
const sync = jest.mocked(syncClaudeSubscriptionCredential);
let directory: string;
let home: string;
const references = {
  projectId: randomUUID(),
  accountId: randomUUID(),
  credentialId: randomUUID(),
  holder: randomUUID(),
  worker: "1:00000000-0000-4000-8000-000000000000:1",
};
jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({ warn: jest.fn() }),
}));
beforeEach(async () => {
  jest.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), "claude-journal-test-"));
  home = await mkdtemp(join(tmpdir(), "cocalc-claude-controller-"));
  manage.mockResolvedValue("released");
  sync.mockImplementation(async ({ current }) => current);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});
const record = () => ({
  ...references,
  home,
  mayHaveLaunched: true,
  baseline: packClaudeSubscriptionBundle(
    new Map([[".credentials.json", Buffer.from("synthetic-old")]]),
  ),
});
test("abandoned controller confirms stop, saves final opaque rotation, and only then releases", async () => {
  const journal = record();
  await writeFile(join(home, ".credentials.json"), "synthetic-rotation");
  await saveClaudeControllerJournal(journal, directory);
  expect(
    (await stat(join(directory, `${references.holder}.json`))).mode & 0o777,
  ).toBe(0o600);
  const order: string[] = [];
  sync.mockImplementation(async ({ current }) => {
    order.push("publish");
    return current;
  });
  manage.mockImplementation(async () => {
    order.push("release");
    return "released";
  });
  await recoverClaudeControllerJournal(
    journal,
    async () => {
      order.push("stop");
    },
    directory,
  );
  expect(order).toEqual(["stop", "publish", "release"]);
  expect(sync.mock.calls[0][0].runtimeId).toBe(references.worker);
  expect(manage.mock.calls[0][0].runtimeId).toBe(references.worker);
  expect(
    sync.mock.calls[0][0].current.get(".credentials.json")?.toString(),
  ).toBe("synthetic-rotation");
  expect(await listClaudeControllerJournals(directory)).toEqual([]);
  await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
});
test("unconfirmed stop never reads or publishes and preserves the recovery journal", async () => {
  const journal = record();
  await saveClaudeControllerJournal(journal, directory);
  await expect(
    recoverClaudeControllerJournal(
      journal,
      async () => {
        throw Error("stop unknown");
      },
      directory,
    ),
  ).rejects.toThrow("stop unknown");
  expect(sync).not.toHaveBeenCalled();
  expect(manage).not.toHaveBeenCalled();
  expect(await listClaudeControllerJournals(directory)).toHaveLength(1);
});

test("a malformed journal does not prevent discovery of valid recovery records", async () => {
  await saveClaudeControllerJournal(record(), directory);
  await writeFile(join(directory, `${randomUUID()}.json`), "not-json");
  expect(await listClaudeControllerJournals(directory)).toHaveLength(1);
});
test("failed final publication keeps ownership and the stopped controller's home for retry", async () => {
  const journal = record();
  await writeFile(join(home, ".credentials.json"), "synthetic-rotation");
  await saveClaudeControllerJournal(journal, directory);
  sync.mockRejectedValueOnce(Error("publication unknown"));
  await expect(
    recoverClaudeControllerJournal(journal, async () => {}, directory),
  ).rejects.toThrow("publication unknown");
  expect(manage).not.toHaveBeenCalled();
  expect(await readFile(join(home, ".credentials.json"), "utf8")).toBe(
    "synthetic-rotation",
  );
  await recoverClaudeControllerJournal(journal, async () => {}, directory);
  expect(await listClaudeControllerJournals(directory)).toEqual([]);
});
test("recovery after an unknown release retains the successfully published baseline", async () => {
  const journal = record();
  const previousBaseline = journal.baseline;
  await writeFile(join(home, ".credentials.json"), "synthetic-rotation");
  await saveClaudeControllerJournal(journal, directory);
  manage.mockRejectedValueOnce(Error("release unknown"));
  await expect(
    recoverClaudeControllerJournal(journal, async () => {}, directory),
  ).rejects.toThrow("release unknown");
  const [saved] = await listClaudeControllerJournals(directory);
  expect(saved.baseline).not.toBe(previousBaseline);
});
