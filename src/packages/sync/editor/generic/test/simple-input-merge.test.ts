import { SimpleInputMerge } from "../simple-input-merge";

describe("SimpleInputMerge", () => {
  it("adopts remote directly when there are no local edits", () => {
    const merge = new SimpleInputMerge("a");
    let local = "a";
    merge.handleRemote({
      remote: "b",
      getLocal: () => local,
      applyMerged: (v) => {
        local = v;
      },
    });
    expect(local).toBe("b");
  });

  it("does not duplicate text when pending echo arrives after local advanced", () => {
    const merge = new SimpleInputMerge("abc");
    let local = "abcXYZ";
    merge.noteSaved(local);

    // User keeps typing before the save echo arrives.
    local = "abcXYZ123";
    let applied = 0;
    merge.handleRemote({
      remote: "abcXYZ",
      getLocal: () => local,
      applyMerged: (v) => {
        applied += 1;
        local = v;
      },
    });

    // Local buffer should not be touched or duplicated by stale-base rebasing.
    expect(local).toBe("abcXYZ123");
    expect(applied).toBe(0);
  });

  it("merges later remote updates without replaying saved segment", () => {
    const merge = new SimpleInputMerge("abc");
    let local = "abcXYZ";
    merge.noteSaved(local);

    // Save echo arrives while user has already typed more.
    local = "abcXYZ123";
    merge.handleRemote({
      remote: "abcXYZ",
      getLocal: () => local,
      applyMerged: (v) => {
        local = v;
      },
    });

    // A new remote change arrives. Result may vary in ordering, but must not
    // replay the already-saved "XYZ" segment.
    merge.handleRemote({
      remote: "abcXYZREMOTE",
      getLocal: () => local,
      applyMerged: (v) => {
        local = v;
      },
    });
    expect(local.includes("XYZXYZ")).toBe(false);
    expect(local).toContain("XYZ");
    expect(local).toContain("123");
    expect(local).toContain("REMOTE");
  });
});
