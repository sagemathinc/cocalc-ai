import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { collectTaskExport } from "./tasks";

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

describe("tasks export", () => {
  it("exports normalized task rows and markdown", async () => {
    const tmp = await mkdtemp("cocalc-export-tasks-");
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
        due_date: Date.UTC(2026, 2, 7, 8, 30, 0),
        last_edited: Date.UTC(2026, 2, 5, 13, 0, 0),
      },
    ]);

    const bundle = await collectTaskExport({ taskPath });
    expect(bundle.manifest.kind).toBe("tasks");
    expect((bundle.manifest as any).entrypoints.canonical_data).toEqual([
      "tasks.jsonl",
    ]);
    expect(bundle.rootDir).toBe("todo");
    const readme = `${bundle.files.find((file) => file.path === "README.md")?.content ?? ""}`;
    expect(readme).toContain("canonical normalized task stream");

    const document = JSON.parse(
      `${bundle.files.find((file) => file.path === "document.json")?.content ?? "{}"}`,
    );
    expect(document).toMatchObject({
      task_count: 2,
      open_count: 1,
      done_count: 1,
      deleted_count: 0,
      hashtags: ["alpha", "bug"],
    });

    const tasksJsonl = `${bundle.files.find((file) => file.path === "tasks.jsonl")?.content ?? ""}`
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(tasksJsonl[0]).toMatchObject({
      event: "task",
      message_kind: "task",
      task_id: "task-open",
      content: "Open task\n\n#alpha #bug",
      hashtags: ["alpha", "bug"],
      done: false,
      deleted: false,
    });
    expect(tasksJsonl[1].due_at).toBe("2026-03-07T08:30:00.000Z");

    const markdown = `${bundle.files.find((file) => file.path === "tasks.md")?.content ?? ""}`;
    expect(markdown).toContain("## Open Tasks");
    expect(markdown).toContain("## Done Tasks");
    expect(markdown).toContain("#alpha #bug");
  });
});
