import { CodexExecAgent } from "../codex-exec";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

  it("passes local images as top-level codex exec args", () => {
    const args = (agent as any).buildArgs(
      { model: "gpt-5.4-mini" },
      "/tmp/project",
      ["/tmp/one.png", "/tmp/two.png"],
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--image",
        "/tmp/one.png",
        "--image",
        "/tmp/two.png",
        "exec",
      ]),
    );
    expect(args.indexOf("/tmp/one.png")).toBeLessThan(args.indexOf("exec"));
    expect(args.indexOf("/tmp/two.png")).toBeLessThan(args.indexOf("exec"));
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

  it("does not emit write events for failed write-like commands", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codex-write-"));
    const streamEvents: any[] = [];
    const stream = async (msg: any) => {
      streamEvents.push(msg);
    };
    const cache = (agent as any).createPreContentCache();
    await (agent as any).handleItem(
      {
        type: "command_execution",
        id: "cmd-failed-write",
        command: "cp missing-src.txt maybe-dest.txt",
        aggregated_output: "cp: cannot stat 'missing-src.txt': No such file",
        exit_code: 1,
      },
      stream,
      cwd,
      cache,
      () => {},
    );
    const fileWriteEvents = streamEvents.filter(
      (msg) => msg?.type === "event" && msg?.event?.type === "file",
    );
    expect(fileWriteEvents).toHaveLength(0);
    const terminalExit = streamEvents.find(
      (msg) =>
        msg?.type === "event" &&
        msg?.event?.type === "terminal" &&
        msg?.event?.phase === "exit",
    );
    expect(terminalExit).toBeDefined();
  });

  it("emits write events only for existing file targets", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codex-write-"));
    await fs.writeFile(path.join(cwd, "dest.txt"), "updated");
    const streamEvents: any[] = [];
    const stream = async (msg: any) => {
      streamEvents.push(msg);
    };
    const cache = (agent as any).createPreContentCache();
    await (agent as any).handleItem(
      {
        type: "command_execution",
        id: "cmd-write",
        command: "cp source.txt dest.txt",
        aggregated_output: "",
        exit_code: 0,
      },
      stream,
      cwd,
      cache,
      () => {},
    );
    const fileWriteEvents = streamEvents.filter(
      (msg) =>
        msg?.type === "event" &&
        msg?.event?.type === "file" &&
        msg?.event?.operation === "write",
    );
    expect(fileWriteEvents).toHaveLength(1);
    expect(fileWriteEvents[0].event.path).toBe("dest.txt");
    expect(typeof fileWriteEvents[0].event.bytes).toBe("number");
  });

  it("does not emit write events for in-progress write-like commands", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codex-write-"));
    await fs.writeFile(path.join(cwd, "dest.txt"), "existing");
    const streamEvents: any[] = [];
    const stream = async (msg: any) => {
      streamEvents.push(msg);
    };
    const cache = (agent as any).createPreContentCache();
    await (agent as any).handleItem(
      {
        type: "command_execution",
        id: "cmd-write-started",
        command: "cp source.txt dest.txt",
      },
      stream,
      cwd,
      cache,
      () => {},
    );
    const fileWriteEvents = streamEvents.filter(
      (msg) =>
        msg?.type === "event" &&
        msg?.event?.type === "file" &&
        msg?.event?.operation === "write",
    );
    expect(fileWriteEvents).toHaveLength(0);
  });

  it("does not report file-size bytes for command-heuristic read events", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codex-read-"));
    await fs.writeFile(
      path.join(cwd, "sample.txt"),
      Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n"),
    );
    const streamEvents: any[] = [];
    const stream = async (msg: any) => {
      streamEvents.push(msg);
    };
    const cache = (agent as any).createPreContentCache();
    await (agent as any).handleItem(
      {
        type: "command_execution",
        id: "cmd-read",
        command: "sed -n '1,20p' sample.txt",
        aggregated_output: "",
        exit_code: 0,
      },
      stream,
      cwd,
      cache,
      () => {},
    );
    const fileReadEvents = streamEvents.filter(
      (msg) =>
        msg?.type === "event" &&
        msg?.event?.type === "file" &&
        msg?.event?.operation === "read",
    );
    expect(fileReadEvents).toHaveLength(1);
    expect(fileReadEvents[0].event.path).toBe("sample.txt");
    expect(fileReadEvents[0].event.bytes).toBeUndefined();
    expect(fileReadEvents[0].event.line).toBe(1);
    expect(fileReadEvents[0].event.limit).toBe(20);
  });
});
