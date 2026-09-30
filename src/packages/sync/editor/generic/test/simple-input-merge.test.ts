import { SimpleInputMerge } from "../simple-input-merge";

describe("SimpleInputMerge", () => {
  it("does not rebase a stale rendered value while a remote update is pending", () => {
    const original = "%time a = random_matrix(GF(7),300)^2";
    const firstRemote =
      "%time a = random_matrix(GF(7),300)*random_matrix(GF(7),300)";
    const secondRemote =
      "a = random_matrix(GF(7),300)*random_matrix(GF(7),300)";
    const merge = new SimpleInputMerge(original);
    let rendered = original;
    const requested: string[] = [];

    const applyMerged = (value: string) => {
      requested.push(value);
      merge.noteSaved(value);
      // React and CodeMirror do not necessarily render this synchronously.
    };
    merge.handleRemote({
      remote: firstRemote,
      getLocal: () => rendered,
      applyMerged,
    });
    merge.handleRemote({
      remote: secondRemote,
      getLocal: () => rendered,
      applyMerged,
    });

    expect(requested).toEqual([firstRemote, secondRemote]);
    expect(rendered).toBe(original);
  });

  it("recognizes an intermediate value from multiple pending renders", () => {
    const original = "base";
    const firstRemote = "one\nbase";
    const secondRemote = "two\nbase";
    const thirdRemote = "three\nbase";
    const merge = new SimpleInputMerge(original);
    let rendered = original;
    const requested: string[] = [];
    const applyMerged = (value: string) => {
      requested.push(value);
      merge.noteSaved(value);
    };

    merge.handleRemote({
      remote: firstRemote,
      getLocal: () => rendered,
      applyMerged,
    });
    merge.handleRemote({
      remote: secondRemote,
      getLocal: () => rendered,
      applyMerged,
    });
    rendered = firstRemote;
    merge.handleRemote({
      remote: thirdRemote,
      getLocal: () => rendered,
      applyMerged,
    });

    expect(requested).toEqual([firstRemote, secondRemote, thirdRemote]);
  });

  it.each([false, true])(
    "preserves a user edit made from the pre-update rendered value (saved: %s)",
    (saved) => {
      const original = "base";
      const firstRemote = "remote 1\nbase";
      const secondRemote = "remote 2\nbase";
      const merge = new SimpleInputMerge(original);
      let rendered = original;
      let requested = "";
      const applyMerged = (value: string) => {
        requested = value;
      };

      merge.handleRemote({
        remote: firstRemote,
        getLocal: () => rendered,
        applyMerged,
      });
      rendered = `${original}\nlocal`;
      if (saved) merge.noteSaved(rendered);
      merge.handleRemote({
        remote: secondRemote,
        getLocal: () => rendered,
        applyMerged,
      });

      expect(requested).toBe(`${secondRemote}\nlocal`);
    },
  );

  it("preserves a user edit made from the post-update rendered value", () => {
    const original = "base";
    const firstRemote = "remote 1\nbase";
    const secondRemote = "remote 2\nbase";
    const merge = new SimpleInputMerge(original);
    let rendered = original;
    let requested = "";
    const applyMerged = (value: string) => {
      requested = value;
    };

    merge.handleRemote({
      remote: firstRemote,
      getLocal: () => rendered,
      applyMerged,
    });
    rendered = `${firstRemote}\nlocal`;
    merge.handleRemote({
      remote: secondRemote,
      getLocal: () => rendered,
      applyMerged,
    });

    expect(requested).toBe(`${secondRemote}\nlocal`);
  });

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

  it.each(["local", "remote"])(
    "does not rebase from a stale render request after later local saves (%s echo)",
    (echo) => {
      // Regression for a collaborative session where a focused rich editor did
      // not render a remote change exactly, so the requested render was never
      // observed. The user then kept typing and saving. When the next remote
      // change arrived, the stale render request replaced the up-to-date base,
      // and the rebase replayed text that the remote already contained.
      const original = "x\n- - H\n";
      const remoteFix = "x\n- H\n";
      const merge = new SimpleInputMerge(original);
      let rendered = original;
      merge.handleRemote({
        remote: remoteFix,
        getLocal: () => rendered,
        applyMerged: () => {
          // The editor kept its old structure.
        },
      });

      // Local typing is saved and echoed back from the backing store.
      const saved = "x\n- - H\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";
      rendered = saved;
      merge.noteSaved(saved);
      if (echo === "local") {
        merge.noteLocalEcho(saved);
      } else {
        merge.handleRemote({
          remote: saved,
          getLocal: () => rendered,
          applyMerged: (value) => {
            rendered = value;
          },
        });
      }

      // The collaborator's editor removes the stray list marker again.
      const remote = "x\n- H\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";
      let merged: string | undefined;
      merge.handleRemote({
        remote,
        getLocal: () => rendered,
        applyMerged: (value) => {
          merged = value;
        },
      });

      expect(merged).toBe(remote);
    },
  );

  it("keeps an unsaved local edit when two remote updates arrive before it is saved", () => {
    // Found by the collaborative editing fuzzer: after rebasing a local edit
    // onto one remote update, the merge became the baseline even though the
    // edit was not committed yet. A second remote update then looked like "no
    // local edits" and was adopted directly, dropping the edit.
    const base = "a\n\nb\n\nc\n";
    const merge = new SimpleInputMerge(base);
    let rendered = `${base}local\n`;
    const remote1 = `x\n\n${base}`;
    merge.handleRemote({
      remote: remote1,
      getLocal: () => rendered,
      applyMerged: (value) => {
        rendered = value;
      },
    });
    expect(rendered).toBe(`${remote1}local\n`);

    const remote2 = `x\n\n${base}y\n`;
    merge.handleRemote({
      remote: remote2,
      getLocal: () => rendered,
      applyMerged: (value) => {
        rendered = value;
      },
    });
    expect(rendered).toContain("local");
    expect(rendered).toContain("y");
  });

  it("keeps an unsaved local edit when the editor canonicalizes a merged value", () => {
    // Found by the collaborative editing fuzzer: the editor rendered a merged
    // value slightly differently (e.g., normalized whitespace). The next remote
    // update then used the merged value itself as the base, treating the
    // uncommitted local edit inside it as committed, and dropped it.
    const base = "a\n\nb\n\nc\n";
    const merge = new SimpleInputMerge(base);
    let rendered = `${base}local \n`;
    const remote1 = `x\n\n${base}`;
    merge.handleRemote({
      remote: remote1,
      getLocal: () => rendered,
      applyMerged: (value) => {
        // The editor strips the trailing space it was given.
        rendered = value.replace("local \n", "local\n");
      },
    });
    expect(rendered).toBe(`${remote1}local\n`);

    const remote2 = `x\n\n${base}y\n`;
    merge.handleRemote({
      remote: remote2,
      getLocal: () => rendered,
      applyMerged: (value) => {
        rendered = value;
      },
    });
    expect(rendered).toContain("local");
    expect(rendered).toContain("y");
  });
});
