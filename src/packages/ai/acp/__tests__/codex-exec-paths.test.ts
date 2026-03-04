import { CodexExecAgent } from "../codex-exec";
import fs from "node:fs/promises";

describe("CodexExecAgent event path formatting", () => {
  const agent = new CodexExecAgent();
  const toEventPath = (pathAbs: string, cwd: string) =>
    (agent as any).toHomeRelative(pathAbs, cwd);

  it("uses cwd-relative paths for files under cwd", () => {
    const cwd = "/home/test/project/src";
    const pathAbs = "/home/test/project/src/packages/backend/sandbox/rustic.ts";
    expect(toEventPath(pathAbs, cwd)).toBe(
      "packages/backend/sandbox/rustic.ts",
    );
  });

  it("keeps absolute paths for files outside cwd", () => {
    const cwd = "/home/test/project/src";
    const pathAbs = "/home/test/project/README.md";
    expect(toEventPath(pathAbs, cwd)).toBe(pathAbs);
  });
});

describe("CodexExecAgent pre-content path heuristics", () => {
  const agent = new CodexExecAgent();
  const extract = (text: string): string[] =>
    (agent as any).extractPathCandidates(text);
  const parseReadOnly = (command: string, cwd: string) =>
    (agent as any).parseReadOnlyCommand(command, cwd);
  const statRegularFile = (pathAbs: string) =>
    (agent as any).statRegularFile(pathAbs);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("does not emit nested suffix paths from a relative path", () => {
    const paths = extract(
      "Please update src/packages/backend/sandbox/rustic.ts and explain the diff.",
    );
    expect(paths).toContain("src/packages/backend/sandbox/rustic.ts");
    expect(paths).not.toContain("packages/backend/sandbox/rustic.ts");
  });

  it("does not emit nested suffix paths from an absolute path", () => {
    const paths = extract(
      "Look at /home/wstein/build/cocalc-lite3/src/packages/backend/sandbox/rustic.ts first.",
    );
    expect(paths).toContain(
      "/home/wstein/build/cocalc-lite3/src/packages/backend/sandbox/rustic.ts",
    );
    expect(paths).not.toContain("packages/backend/sandbox/rustic.ts");
    expect(paths).not.toContain(
      "/home/wstein/build/cocalc-lite3/packages/backend/sandbox/rustic.ts",
    );
  });

  it("does not treat rg pipelines as single file reads", () => {
    const read = parseReadOnly(
      `rg -n "COCALC_ACP_" src/packages | head -n 200`,
      "/home/wstein/build/cocalc-lite3/src",
    );
    expect(read).toBeNull();
  });

  it("does not emit read events when stat says path is not a file", async () => {
    jest.spyOn(fs, "stat").mockResolvedValue({
      isFile: () => false,
      size: 0,
    } as any);
    await expect(
      statRegularFile("/home/wstein/build/cocalc-lite3/src/packages"),
    ).resolves.toBeNull();
  });

  it("does not emit read events when stat fails with ENOENT", async () => {
    jest.spyOn(fs, "stat").mockRejectedValue({ code: "ENOENT" });
    await expect(
      statRegularFile("/home/wstein/build/cocalc-lite3/src/missing.tex"),
    ).resolves.toBeNull();
  });

  it("maps /root and /scratch paths to host mounts in project-host mode", async () => {
    const statSpy = jest.spyOn(fs, "stat").mockResolvedValue({
      isFile: () => true,
      size: 123,
    } as any);
    await expect(
      (agent as any).statRegularFile("/root/work/foo.tex", {
        containerPathMap: {
          rootHostPath: "/host/home",
          scratchHostPath: "/host/scratch",
        },
      }),
    ).resolves.toEqual({ size: 123 });
    expect(statSpy).toHaveBeenCalledWith("/host/home/work/foo.tex");
  });

  it("rejects non-/root and non-/scratch paths in project-host mode", async () => {
    const statSpy = jest.spyOn(fs, "stat").mockResolvedValue({
      isFile: () => true,
      size: 123,
    } as any);
    await expect(
      (agent as any).statRegularFile("/etc/passwd", {
        containerPathMap: {
          rootHostPath: "/host/home",
          scratchHostPath: "/host/scratch",
        },
      }),
    ).resolves.toBeNull();
    expect(statSpy).not.toHaveBeenCalled();
  });
});
