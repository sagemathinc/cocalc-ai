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
test("historical nested source absent all inventories is adopted only by the explicit worker", async () => {
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
  // One bounded step visits multiple directories; replay after restart also works
  // if the cooperative wall clock budget ended before reaching the candidate.
  await runtime!.close();
  runtime = undefined;
  jest.spyOn(Date, "now").mockReturnValue(Date.now() + 30_001);
  setup();
  await runtime!.service.runOnce();
  const page = await runtime!.api.listResources({ account_id });
  expect(page.items).toEqual([
    expect.objectContaining({
      resource_id: thread_id,
      chat_path: path,
      title: "Previously unknown",
    }),
  ]);
  const discovery = await runtime!.api.getDiscovery({ account_id, project_id });
  expect(discovery.report?.candidates).toBe(1);
  expect(JSON.stringify(discovery)).not.toContain(directory);
  expect(JSON.stringify(discovery)).not.toContain("Never copy");
  expect(page.coverage).not.toBe("complete");
});
test("disabled runtime cannot census or report and symlink scope remains partial", async () => {
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
  expect(discovery).toMatchObject({
    status: "partial",
    report: { skipped_symlinks: 1 },
  });
  await expect(
    runtime!.api.getDiscovery({ account_id: randomUUID(), project_id }),
  ).rejects.toThrow();
  await expect(runtime!.api.discoveryForHost({ project_id })).rejects.toThrow();
});
