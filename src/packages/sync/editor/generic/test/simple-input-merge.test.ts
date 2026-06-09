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

  it("ignores an older echoed save after a newer local save is already pending", () => {
    const merge = new SimpleInputMerge("hello");
    let local = "hello world";
    merge.noteSaved(local);

    local = "hello world again";
    merge.noteSaved(local);

    let applied = 0;
    merge.handleRemote({
      remote: "hello world",
      getLocal: () => local,
      applyMerged: (v) => {
        applied += 1;
        local = v;
      },
    });

    expect(local).toBe("hello world again");
    expect(applied).toBe(0);

    merge.handleRemote({
      remote: "hello world again",
      getLocal: () => local,
      applyMerged: (v) => {
        applied += 1;
        local = v;
      },
    });

    expect(local).toBe("hello world again");
    expect(applied).toBe(0);
  });

  it("does not replay a local insert when remote already equals local", () => {
    const merge = new SimpleInputMerge("P1-B: item");
    let local = "(done) P1-B: item";
    let applied = 0;

    merge.handleRemote({
      remote: "(done) P1-B: item",
      getLocal: () => local,
      applyMerged: (value) => {
        applied += 1;
        local = value;
      },
    });

    expect(local).toBe("(done) P1-B: item");
    expect(applied).toBe(0);

    merge.handleRemote({
      remote: "(done) P1-B: item\nnext",
      getLocal: () => local,
      applyMerged: (value) => {
        applied += 1;
        local = value;
      },
    });

    expect(local).toBe("(done) P1-B: item\nnext");
    expect(applied).toBe(1);
  });

  it("does not replay a locally echoed save with canonicalization drift", () => {
    const merge = new SimpleInputMerge("P1-B: item");
    let local = "(done) P1-B: item\n";
    merge.noteSaved(local);

    // The local backing store can synchronously echo a canonical variant of
    // the requested save. This is causally our save, so it must advance the
    // merge baseline instead of becoming a remote target for replaying the
    // same local patch.
    merge.noteLocalEcho("(done) P1-B: item");

    local = "(done) P1-B: item and more";
    let applied = 0;
    merge.handleRemote({
      remote: "(done) P1-B: item",
      getLocal: () => local,
      applyMerged: (value) => {
        applied += 1;
        local = value;
      },
    });

    expect(local).toBe("(done) P1-B: item and more");
    expect(local).not.toContain("(done) (done)");
    expect(applied).toBe(0);
  });
});
