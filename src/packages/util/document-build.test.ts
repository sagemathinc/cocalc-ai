import {
  BUILDABLE_EXTENSIONS,
  buildJobGroup,
  buildRequestJobKey,
  buildStageJobKey,
  canonicalBuildPath,
  documentExtension,
  isBuildableDocument,
  parseBuildRequest,
  parseBuildStage,
} from "./document-build";

describe("buildJobGroup", () => {
  it("namespaces the document path", () => {
    expect(buildJobGroup("/root/paper.tex")).toBe("build:/root/paper.tex");
  });

  it("gives distinct groups to distinct documents", () => {
    expect(buildJobGroup("/root/a.tex")).not.toEqual(
      buildJobGroup("/root/b.tex"),
    );
  });
});

describe("documentExtension", () => {
  it("lowercases and ignores directories", () => {
    expect(documentExtension("/root/a.b/Paper.TeX")).toBe("tex");
    expect(documentExtension("/root/report.Rmd")).toBe("rmd");
  });

  it("returns empty for no extension or dotfiles", () => {
    expect(documentExtension("/root/notes")).toBe("");
    expect(documentExtension("/root/.hidden")).toBe("");
    expect(documentExtension("")).toBe("");
  });
});

describe("isBuildableDocument", () => {
  it("accepts every editor extension that has a build action", () => {
    for (const ext of BUILDABLE_EXTENSIONS) {
      expect(isBuildableDocument(`/root/doc.${ext}`)).toBe(true);
    }
    // case-insensitively, as the editors register lowercase extensions
    expect(isBuildableDocument("/root/report.RMD")).toBe(true);
  });

  it("rejects documents whose editor cannot build", () => {
    expect(isBuildableDocument("/root/notes.md")).toBe(false);
    expect(isBuildableDocument("/root/nb.ipynb")).toBe(false);
    expect(isBuildableDocument("/root/notes")).toBe(false);
  });
});

describe("canonicalBuildPath", () => {
  it("maps knitr sources to the derived .tex the editor actually watches", () => {
    // the latex editor rewrites its own path to .tex in init_ext_path before
    // installing the build watcher, so a request for the .Rnw would go to a
    // job group nobody listens on
    expect(canonicalBuildPath("/root/paper.Rnw")).toBe("/root/paper.tex");
    expect(canonicalBuildPath("/root/paper.rtex")).toBe("/root/paper.tex");
  });

  it("leaves every other document untouched", () => {
    expect(canonicalBuildPath("/root/paper.tex")).toBe("/root/paper.tex");
    expect(canonicalBuildPath("/root/report.Rmd")).toBe("/root/report.Rmd");
    expect(canonicalBuildPath("/root/report.qmd")).toBe("/root/report.qmd");
  });
});

describe("buildJobGroup canonicalization", () => {
  it("sends knitr requests to the .tex group", () => {
    expect(buildJobGroup("/root/paper.Rnw")).toBe("build:/root/paper.tex");
    expect(buildJobGroup("/root/paper.Rnw")).toEqual(
      buildJobGroup("/root/paper.tex"),
    );
  });
});

describe("build request tags", () => {
  it("round-trips the id and the requested path", () => {
    expect(
      parseBuildRequest(
        buildRequestJobKey({ request_id: "abc-123", path: "/root/paper.Rnw" }),
      ),
    ).toEqual({ request_id: "abc-123", path: "/root/paper.Rnw" });
  });

  it("survives paths containing separators and spaces", () => {
    const path = "/root/a:b/my paper (final).tex";
    expect(
      parseBuildRequest(buildRequestJobKey({ request_id: "id-1", path })),
    ).toEqual({ request_id: "id-1", path });
  });

  it("distinguishes the two members of a knitr pair", () => {
    // both share a build group, so the tag is what tells the editors apart
    const rnw = parseBuildRequest(
      buildRequestJobKey({ request_id: "r", path: "/root/paper.Rnw" }),
    );
    const tex = parseBuildRequest(
      buildRequestJobKey({ request_id: "r", path: "/root/paper.tex" }),
    );
    expect(rnw?.path).not.toEqual(tex?.path);
  });

  it("ignores job keys that are not build requests", () => {
    expect(parseBuildRequest("latex")).toBeUndefined();
    expect(parseBuildRequest(undefined)).toBeUndefined();
    expect(parseBuildRequest("build-request:")).toBeUndefined();
    expect(parseBuildRequest("build-request:only-id")).toBeUndefined();
  });
});

describe("build stage tags", () => {
  it("round-trips the stage and the logical path", () => {
    expect(
      parseBuildStage(
        buildStageJobKey({ stage: "latex", path: "/root/a.tex" }),
      ),
    ).toEqual({ stage: "latex", path: "/root/a.tex" });
  });

  it("survives paths containing separators and spaces", () => {
    const path = "/root/a:b/my paper (final).Rnw";
    expect(parseBuildStage(buildStageJobKey({ stage: "knitr", path }))).toEqual(
      {
        stage: "knitr",
        path,
      },
    );
  });

  it("separates a knitr pipeline from a build of its generated .tex", () => {
    // the stages run the same commands over the same files, so the key is the
    // only thing that says which pipeline they belong to
    expect(
      buildStageJobKey({ stage: "latex", path: "/root/paper.Rnw" }),
    ).not.toEqual(
      buildStageJobKey({ stage: "latex", path: "/root/paper.tex" }),
    );
  });

  it("ignores job keys that are not pipeline stages", () => {
    expect(parseBuildStage(undefined)).toBeUndefined();
    expect(parseBuildStage("latex")).toBeUndefined();
    expect(parseBuildStage("latex:")).toBeUndefined();
    expect(parseBuildStage(":/root/a.tex")).toBeUndefined();
    expect(parseBuildStage("rmd:/root/a.Rmd")).toBeUndefined();
    expect(
      parseBuildStage(
        buildRequestJobKey({ request_id: "r", path: "/root/a.tex" }),
      ),
    ).toBeUndefined();
  });
});
