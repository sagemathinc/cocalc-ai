import {
  commandText,
  MAX_COMMAND_BYTES,
  MAX_TRANSFER_BYTES,
  maxRuntimeMs,
  OperationError,
  parseOperationRequest,
} from "./operations";

describe("parseOperationRequest", () => {
  it("fills exec defaults: closed stdin, 10 minute timeout", () => {
    expect(parseOperationRequest("exec", { command: "docker ps" })).toEqual({
      operation: "exec",
      request: {
        command: "docker ps",
        argv: null,
        cwd: null,
        timeout_ms: 600_000,
        stdin: null,
      },
    });
  });

  it("gives the same canonical request for equivalent inputs", () => {
    const a = parseOperationRequest("run", {
      command: "make",
      description: " build ",
    });
    const b = parseOperationRequest("run", {
      description: "build",
      command: "make",
      exclusive: false,
      nice: true,
      name: null,
      cwd: "",
    });
    expect(a).toEqual(b);
  });

  it("takes the exact arguments of one command as argv", () => {
    const argv = ["sh", "-c", "du -sh ~/* | sort -h", "it's \\'"];
    expect(parseOperationRequest("exec", { argv }).request).toMatchObject({
      command: null,
      argv,
    });
    expect(
      commandText({ command: null, argv: ["ls", "-la", "a b", "it's"] }),
    ).toBe(`ls -la 'a b' 'it'\\''s'`);
  });

  it("requires a description for jobs", () => {
    expect(() => parseOperationRequest("run", { command: "make" })).toThrow(
      /description/,
    );
    expect(() =>
      parseOperationRequest("run", { command: "make", description: "a\nb" }),
    ).toThrow(OperationError);
  });

  it.each<[string, any, any]>([
    ["an unknown field", "exec", { command: "ls", sudo: true }],
    ["an empty command", "exec", { command: "  " }],
    ["both command and argv", "exec", { command: "ls", argv: ["ls"] }],
    ["neither command nor argv", "exec", {}],
    ["an empty argv", "exec", { argv: [] }],
    ["an argv with a number", "exec", { argv: ["ls", 1] }],
    ["an argv with an empty command", "run", { argv: [""], description: "d" }],
    ["an argv with NUL", "exec", { argv: ["echo", "a\u0000b"] }],
    ["a huge argv", "exec", { argv: ["echo", "x".repeat(MAX_COMMAND_BYTES)] }],
    ["a huge command", "exec", { command: "x".repeat(MAX_COMMAND_BYTES + 1) }],
    ["an exec over an hour", "exec", { command: "ls", timeout_ms: 3_600_001 }],
    [
      "stdin that isn't base64",
      "exec",
      { command: "cat", stdin: "not base64!" },
    ],
    ["a bad job id", "kill", { job_id: "1" }],
    [
      "a transfer over 2 GB",
      "put",
      { path: "data", bytes: MAX_TRANSFER_BYTES + 1 },
    ],
    ["a bad job name", "run", { command: "x", description: "d", name: "../x" }],
    ["fields for info", "info", { x: 1 }],
  ])("refuses %s", (_label, op, request) => {
    expect(() => parseOperationRequest(op, request)).toThrow(OperationError);
  });

  it("bounds runtimes per operation", () => {
    expect(
      maxRuntimeMs(
        parseOperationRequest("exec", { command: "ls", timeout_ms: 5000 }),
      ),
    ).toBe(5000);
    expect(maxRuntimeMs(parseOperationRequest("info", {}))).toBe(60_000);
  });
});
