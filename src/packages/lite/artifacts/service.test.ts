/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { publishArtifact } from "@cocalc/chat";
import { createLiteArtifactCatalog } from "./service";

const project_id = "11111111-1111-4111-8111-111111111111";
const account_id = "local-account";

function document(): string {
  const rows: any[] = [];
  publishArtifact(
    {
      get_one: (key: object) =>
        rows.find((row) => Object.entries(key).every(([k, v]) => row[k] === v)),
      set: (values: any[]) => {
        rows.push(...values);
      },
    },
    {
      thread_id: "thread",
      artifact_id: "notes",
      operation_id: "op",
      message_id: "message",
      title: "Notes",
      markdown: "private body",
    },
  );
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

test("real Lite filesystem writes, retries, rename, deletion and service lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "lite-artifact-service-"));
  const options = {
    directory: join(root, "private"),
    path: root,
    project_id,
    account_id,
  };
  const runtime = createLiteArtifactCatalog(options);
  const fs = runtime.wrapFilesystem(
    new SandboxedFilesystem(root, { unsafeMode: true, rootfs: "/" }),
    project_id,
  );
  // Exercise the real worker pass without scheduling timers in this unit test.
  const tick = () =>
    (runtime.service as unknown as { runOnce(): Promise<void> }).runOnce();
  try {
    await fs.writeFile("test.chat", document());
    await tick();
    let page = await runtime.api.listProject({ project_id, account_id });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].chat_path).toBe(join(root, "test.chat"));
    expect(page.entries[0].item.title).toBe("Notes");
    expect(JSON.stringify(page)).not.toContain("private body");
    await expect(runtime.api.ingest()).rejects.toThrow("service-local");
    await fs.writeFile("test.chat", "{invalid json");
    await tick();
    expect(
      (await runtime.api.listProject({ project_id, account_id })).entries,
    ).toEqual(page.entries);
    await fs.writeFile("test.chat", document());
    await fs.rename("test.chat", "renamed.chat");
    await tick();
    page = await runtime.api.listProject({ project_id, account_id });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].chat_path).toBe(join(root, "renamed.chat"));
    await fs.unlink("renamed.chat");
    await tick();
    expect(
      (await runtime.api.listProject({ project_id, account_id })).entries,
    ).toEqual([]);
    runtime.stop();
    expect(() => createLiteArtifactCatalog(options)).toThrow(/locked/);
  } finally {
    fs.close();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("background discovery indexes historical chats without opening a browser", async () => {
  const root = mkdtempSync(join(tmpdir(), "lite-artifact-backfill-"));
  writeFileSync(join(root, "historical.chat"), document());
  const runtime = createLiteArtifactCatalog({
    directory: join(root, "private"),
    path: root,
    project_id,
    account_id,
  });
  try {
    await (
      runtime.service as unknown as { runOnce(): Promise<void> }
    ).runOnce();
    const page = await runtime.api.listProject({ project_id, account_id });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].chat_path).toBe(join(root, "historical.chat"));
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
