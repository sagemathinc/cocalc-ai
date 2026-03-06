import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { collectWhiteboardExport } from "./whiteboard";

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

describe("whiteboard export", () => {
  it("exports board pages with per-page markdown", async () => {
    const tmp = await mkdtemp("cocalc-export-board-");
    const boardPath = path.join(tmp, "sample.board");
    await writeJsonl(boardPath, [
      { type: "page", id: "page-a", data: { pos: 0 } },
      { type: "page", id: "page-b", data: { pos: 1 } },
      { id: "elt-1", type: "text", page: "page-a", x: 0, y: 0, z: 1, str: "# First page" },
      { id: "elt-2", type: "note", page: "page-b", x: 0, y: 10, z: 1, str: "Second page" },
    ]);

    const bundle = await collectWhiteboardExport({
      documentPath: boardPath,
      kind: "board",
    });

    expect(bundle.manifest.kind).toBe("board");
    const pageIndex = JSON.parse(
      `${bundle.files.find((file) => file.path === "pages/index.json")?.content ?? "[]"}`,
    );
    expect(pageIndex).toHaveLength(2);
    expect(pageIndex[0]).toMatchObject({ page_id: "page-a", title: "First page" });
    const content = `${bundle.files.find((file) => file.path === "pages/0001-page-a/content.md")?.content ?? ""}`;
    expect(content).toContain("# First page");
    const documentMd = `${bundle.files.find((file) => file.path === "document.md")?.content ?? ""}`;
    expect(documentMd).toContain("## Page 1: First page");
    expect(documentMd).toContain("## Page 2: Second page");
  });

  it("exports slides speaker notes separately", async () => {
    const tmp = await mkdtemp("cocalc-export-slides-");
    const slidesPath = path.join(tmp, "deck.slides");
    await writeJsonl(slidesPath, [
      { type: "page", id: "slide-a", data: { pos: 0 } },
      { id: "elt-1", type: "text", page: "slide-a", x: 0, y: 0, z: 1, str: "# Intro" },
      {
        id: "notes-1",
        type: "speaker_notes",
        page: "slide-a",
        invisible: true,
        x: 0,
        y: 0,
        z: 2,
        str: "Talk through the intro",
      },
    ]);

    const bundle = await collectWhiteboardExport({
      documentPath: slidesPath,
      kind: "slides",
    });

    expect(bundle.manifest.kind).toBe("slides");
    const document = JSON.parse(
      `${bundle.files.find((file) => file.path === "document.json")?.content ?? "{}"}`,
    );
    expect(document.presentation).toMatchObject({ aspect_ratio: "16:9" });
    const notes = `${bundle.files.find((file) => file.path === "pages/0001-slide-a/speaker-notes.md")?.content ?? ""}`;
    expect(notes).toContain("Talk through the intro");
  });
});
