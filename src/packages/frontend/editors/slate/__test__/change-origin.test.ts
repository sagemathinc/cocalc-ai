import {
  hasOnlySelectionOperations,
  isExternalTreeChange,
  isLocalContentChange,
} from "../change-origin";

describe("Slate change origin", () => {
  it("does not treat remote synchronization as a local edit", () => {
    expect(
      isLocalContentChange({
        operations: [{ type: "insert_text" }],
        syncCausedUpdate: true,
      }),
    ).toBe(false);
  });

  it("does not treat selection changes as content edits", () => {
    const operations = [{ type: "set_selection" }];
    expect(hasOnlySelectionOperations(operations)).toBe(true);
    expect(isLocalContentChange({ operations, syncCausedUpdate: false })).toBe(
      false,
    );
  });

  it("treats local content operations as edits", () => {
    expect(
      isLocalContentChange({
        operations: [{ type: "insert_text" }],
        syncCausedUpdate: false,
      }),
    ).toBe(true);
  });

  it("preserves initial empty-operation change handling", () => {
    expect(
      isLocalContentChange({ operations: [], syncCausedUpdate: false }),
    ).toBe(true);
  });

  describe("an external value's onChange, delivered late", () => {
    const tree = [{ type: "paragraph", children: [{ text: "remote" }] }];
    const externalOp = { type: "insert_text" };
    const external = {
      externalValue: tree,
      externalOperations: new Set<unknown>([externalOp]),
    };

    it("is the external change when the tree and operations are the external ones", () => {
      expect(
        isExternalTreeChange({
          ...external,
          value: tree,
          operations: [externalOp],
        }),
      ).toBe(true);
      // a direct replacement has no operations
      expect(
        isExternalTreeChange({ ...external, value: tree, operations: [] }),
      ).toBe(true);
    });

    it("is a local edit when an operation of its own was applied, even in place", () => {
      expect(
        isExternalTreeChange({
          ...external,
          value: tree,
          operations: [externalOp, { type: "insert_text" }],
        }),
      ).toBe(false);
    });

    it("is a local edit when the tree is a new one", () => {
      expect(
        isExternalTreeChange({
          ...external,
          value: [...tree],
          operations: [],
        }),
      ).toBe(false);
      expect(
        isExternalTreeChange({
          externalValue: null,
          externalOperations: new Set(),
          value: tree,
          operations: [],
        }),
      ).toBe(false);
    });
  });
});
