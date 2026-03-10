import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { collectTaskExport } from "./tasks";
import { bundleToZipBuffer } from "./zip";
import { importTaskBundle } from "./tasks-import";

async function mkdtemp(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeJsonl(filePath: string, rows: any[]): Promise<void> {
  await fs.writeFile(
    filePath,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

async function writeBundleDirectory(
  dirPath: string,
  bundle: {
    manifest: any;
    files: Array<{ path: string; content: string | Uint8Array }>;
  },
): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(
    path.join(dirPath, "manifest.json"),
    `${JSON.stringify(bundle.manifest, null, 2)}\n`,
    "utf8",
  );
  for (const file of bundle.files) {
    const filePath = path.join(dirPath, file.path);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    if (typeof file.content === "string") {
      await fs.writeFile(filePath, file.content, "utf8");
    } else {
      await fs.writeFile(filePath, file.content);
    }
  }
}

describe("tasks import", () => {
  it("imports edited tasks by merging desired rows against the exported base", async () => {
    const tmp = await mkdtemp("cocalc-import-tasks-");
    const taskPath = path.join(tmp, "todo.tasks");
    await writeJsonl(taskPath, [
      {
        task_id: "task-open",
        desc: "Open task\n\n#alpha #bug",
        position: -1,
        last_edited: Date.UTC(2026, 2, 5, 12, 0, 0),
      },
      {
        task_id: "task-done",
        desc: "Done task",
        position: 0,
        done: true,
        last_edited: Date.UTC(2026, 2, 5, 13, 0, 0),
      },
    ]);

    const bundle = await collectTaskExport({ taskPath });
    const exportDir = path.join(tmp, "todo");
    await writeBundleDirectory(exportDir, bundle);
    const desiredPath = path.join(exportDir, "tasks.jsonl");
    const desiredRows = (await fs.readFile(desiredPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    desiredRows[0].content = "Open task updated\n\n#alpha #fixed";
    desiredRows[0].done = true;
    desiredRows.push({
      event: "task",
      message_kind: "task",
      content: "New task from import\n\n#report",
      content_format: "markdown",
      done: false,
      deleted: false,
    });
    await fs.writeFile(
      desiredPath,
      `${desiredRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );

    const result = await importTaskBundle({
      sourcePath: exportDir,
      targetPath: taskPath,
    });
    expect(result).toMatchObject({
      created: 1,
      updated: 1,
      unchanged: 1,
      conflict_count: 0,
      dry_run: false,
    });

    const rows = (await fs.readFile(taskPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.task_id === "task-open")).toMatchObject({
      desc: "Open task updated\n\n#alpha #fixed",
      done: true,
    });
    expect(rows.find((row) => row.task_id === "task-done")).toMatchObject({
      desc: "Done task",
      done: true,
    });
    expect(
      rows.find((row) => row.desc === "New task from import\n\n#report"),
    ).toBeTruthy();
  });

  it("detects conflicting live edits and does not write the target file", async () => {
    const tmp = await mkdtemp("cocalc-import-tasks-conflict-");
    const taskPath = path.join(tmp, "todo.tasks");
    const original = {
      task_id: "task-open",
      desc: "Open task",
      position: 0,
      last_edited: Date.UTC(2026, 2, 5, 12, 0, 0),
    };
    await writeJsonl(taskPath, [original]);

    const bundle = await collectTaskExport({ taskPath });
    const desiredFile = bundle.files.find(
      (file) => file.path === "tasks.jsonl",
    );
    if (desiredFile == null) {
      throw new Error("missing tasks.jsonl in test bundle");
    }
    const desiredRows = `${desiredFile.content}`
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    desiredRows[0].content = "Agent edited task";
    desiredFile.content = `${desiredRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    const zipPath = path.join(tmp, "todo.tasks.cocalc-export.zip");
    await fs.writeFile(zipPath, bundleToZipBuffer(bundle));

    const currentRows = [
      {
        ...original,
        desc: "Live edited task",
        last_edited: Date.UTC(2026, 2, 5, 14, 0, 0),
      },
    ];
    await writeJsonl(taskPath, currentRows);

    const dryRun = await importTaskBundle({
      sourcePath: zipPath,
      targetPath: taskPath,
      dryRun: true,
    });
    expect(dryRun.conflict_count).toBe(1);
    expect(dryRun.conflicts[0]).toMatchObject({
      task_id: "task-open",
      reason: "concurrent_edit",
    });

    await expect(
      importTaskBundle({
        sourcePath: zipPath,
        targetPath: taskPath,
      }),
    ).rejects.toThrow(/conflicting task updates/);

    const rowsAfter = (await fs.readFile(taskPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(rowsAfter[0].desc).toBe("Live edited task");
  });
});
