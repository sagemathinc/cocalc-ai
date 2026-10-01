/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createLiteCollaborators } from "./service";
const account_id = randomUUID(),
  project_id = randomUUID(),
  thread_id = randomUUID();
let directory: string;
let runtime: ReturnType<typeof createLiteCollaborators> | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "lite-census-"));
});
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  jest.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});
function setup(enabled = () => true) {
  const sourcePage = jest.fn(async () => ({ paths: [] as string[] }));
  runtime = createLiteCollaborators({
    directory: join(directory, "private"),
    path: directory,
    account_id,
    project_id,
    isEnabled: enabled,
    sourcePage,
    agentPins: { read: () => [], set: () => {} },
  });
  return sourcePage;
}
function chat(path: string) {
  writeFileSync(
    path,
    [
      {
        event: "chat-thread",
        thread_id,
        created_by: account_id,
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        event: "chat-thread-config",
        thread_id,
        agent_kind: "none",
        name: "Previously unknown",
      },
      {
        event: "chat",
        thread_id,
        message_id: randomUUID(),
        sender_id: account_id,
        date: "2026-01-01T00:00:01Z",
        content: "Never copy this body to census status",
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n"),
  );
}
test("historical sources stay undiscovered through startup, worker ticks, and restart", async () => {
  mkdirSync(join(directory, "node_modules"));
  const path = join(directory, "node_modules", "unnamed.chat");
  chat(path);
  const sourcePage = setup();
  expect((await runtime!.api.listResources({ account_id })).items).toEqual([]);
  expect(await runtime!.api.getDiscovery({ account_id, project_id })).toEqual({
    status: "pending",
  });
  expect(sourcePage).not.toHaveBeenCalled();
  await runtime!.service.runOnce();
  await runtime!.close();
  runtime = undefined;
  jest.spyOn(Date, "now").mockReturnValue(Date.now() + 30_001);
  setup();
  await runtime!.service.runOnce();
  const page = await runtime!.api.listResources({ account_id });
  expect(page.items).toEqual([]);
  expect(runtime!.service.journal.sources()).toEqual([]);
  expect(await runtime!.api.getDiscovery({ account_id, project_id })).toEqual({
    status: "pending",
  });
  expect(page.coverage).not.toBe("complete");
});
test("reenabling indexing does not admit an automatic scan", async () => {
  chat(join(directory, "existing.chat"));
  symlinkSync(directory, join(directory, "linked"));
  let enabled = false;
  const sourcePage = setup(() => enabled);
  await runtime!.service.runOnce();
  expect(sourcePage).not.toHaveBeenCalled();
  expect(runtime!.service.journal.sources()).toEqual([]);
  enabled = true;
  await runtime!.service.runOnce();
  const discovery = await runtime!.api.getDiscovery({ account_id, project_id });
  expect(discovery).toEqual({ status: "pending" });
  expect(runtime!.service.journal.sources()).toEqual([]);
  // Existing known catalog lookup is allowed; it cannot find this unknown file.
  expect(sourcePage).toHaveBeenCalledTimes(1);
  await expect(
    runtime!.api.getDiscovery({ account_id: randomUUID(), project_id }),
  ).rejects.toThrow();
  await expect(runtime!.api.discoveryForHost({ project_id })).rejects.toThrow();
});
