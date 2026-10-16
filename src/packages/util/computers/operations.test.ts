import {
  argvScript,
  commandText,
  MAX_COMMAND_BYTES,
  MAX_EXEC_TIMEOUT_MS,
  OperationError,
  parseExecRequest,
} from "./operations";

describe("parseExecRequest", () => {
  it("fills defaults: closed stdin, 10 minute timeout", () => {
    expect(parseExecRequest({ command: "docker ps" })).toEqual({
      command: "docker ps",
      argv: null,
      cwd: null,
      timeout_ms: 600_000,
      stdin: null,
    });
  });

  it("takes the exact arguments of one command as argv", () => {
    expect(parseExecRequest({ argv: ["ls", "-la", "a b"] })).toMatchObject({
      command: null,
      argv: ["ls", "-la", "a b"],
    });
  });

  it("refuses anything malformed", () => {
    const bad: unknown[] = [
      {},
      { command: "" },
      { command: "ls", argv: ["ls"] },
      { argv: [] },
      { argv: [""] },
      { argv: ["ls", 1] },
      { command: "ls", extra: 1 },
      { command: "ls", timeout_ms: 0 },
      { command: "ls", timeout_ms: MAX_EXEC_TIMEOUT_MS + 1 },
      { command: "ls", timeout_ms: 1.5 },
      { command: "ls", stdin: "not base64!" },
      { command: "ls", cwd: "a\u0000b" },
      { command: "x".repeat(MAX_COMMAND_BYTES + 1) },
      { command: "a\u0000b" },
      [],
      "ls",
    ];
    for (const input of bad) {
      expect(() => parseExecRequest(input)).toThrow(OperationError);
    }
  });

  it("quotes argv so no value is parsed by a shell", () => {
    expect(argvScript(["echo", "a b", "it's", "$HOME"])).toBe(
      `set -- echo 'a b' 'it'\\''s' '$HOME'`,
    );
    expect(commandText({ command: null, argv: ["ls", "a b"] })).toBe(
      "ls 'a b'",
    );
  });
});
