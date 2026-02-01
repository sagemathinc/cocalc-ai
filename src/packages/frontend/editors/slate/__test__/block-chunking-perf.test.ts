import { __test__ } from "../block-markdown-editor-core";

test("incremental chunking keeps the middle slice small for a local edit", () => {
  const prevChunkSize = (globalThis as any).COCALC_SLATE_BLOCK_CHUNK_CHARS;
  (globalThis as any).COCALC_SLATE_BLOCK_CHUNK_CHARS = 400;

  try {
    const blocks = Array.from({ length: 200 }, (_, idx) => {
      return `paragraph ${idx} ${"x".repeat(40)}`;
    });
    const original = blocks.join("\n\n");
    const prevBlocks = __test__.splitMarkdownToBlocks(original);
    const next = `Z${original}`;

    const slices = __test__.computeIncrementalSlices(
      original,
      next,
      prevBlocks,
    );

    expect(slices).not.toBeNull();
    if (!slices) return;

    expect(slices.middleText.length).toBeLessThan(200);
    expect(slices.suffixBlocks.length).toBeGreaterThan(0);
  } finally {
    if (prevChunkSize === undefined) {
      delete (globalThis as any).COCALC_SLATE_BLOCK_CHUNK_CHARS;
    } else {
      (globalThis as any).COCALC_SLATE_BLOCK_CHUNK_CHARS = prevChunkSize;
    }
  }
});
