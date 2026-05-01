import {
  joinBlocks,
  joinBlocksForDocument,
  trailingNewlineSuffix,
} from "../block-markdown-utils";

describe("block markdown document assembly", () => {
  test("joinBlocks does not append a document newline", () => {
    expect(joinBlocks(["alpha", "beta"])).toBe("alpha\n\nbeta");
  });

  test("joinBlocksForDocument preserves the source trailing newline suffix", () => {
    expect(trailingNewlineSuffix("alpha\n\n")).toBe("\n\n");
    expect(joinBlocksForDocument(["alpha", "beta"], "old\n")).toBe(
      "alpha\n\nbeta\n",
    );
    expect(joinBlocksForDocument(["alpha", "beta"], "old\n\n")).toBe(
      "alpha\n\nbeta\n\n",
    );
    expect(joinBlocksForDocument(["alpha", "beta"], "old")).toBe(
      "alpha\n\nbeta",
    );
  });
});
