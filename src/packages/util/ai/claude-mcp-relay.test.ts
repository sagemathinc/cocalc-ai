import { claudeMcpServerLine, McpLineSplitter } from "./claude-mcp-relay";

describe("McpLineSplitter", () => {
  it("returns complete lines, keeping a partial one for later", () => {
    const split = new McpLineSplitter();
    expect(split.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(split.push(":2}\r\n\n")).toEqual(['{"b":2}']);
  });

  it("counts UTF-8 bytes, not characters", () => {
    // 4 characters, 12 bytes
    expect(() => new McpLineSplitter(10).push("éééé\n")).not.toThrow();
    expect(() => new McpLineSplitter(10).push("€€€€\n")).toThrow(/too large/);
  });

  it("refuses a line over the limit, finished or not", () => {
    expect(() => new McpLineSplitter(10).push("x".repeat(11) + "\n")).toThrow(
      /too large/,
    );
    expect(() => new McpLineSplitter(10).push("x".repeat(11))).toThrow(
      /too large/,
    );
  });
});

describe("claudeMcpServerLine", () => {
  const line = (message: object) => JSON.stringify(message);

  it("passes responses, notifications and allowed requests", () => {
    for (const message of [
      { jsonrpc: "2.0", id: 1, result: { tools: [] } },
      { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { jsonrpc: "2.0", id: 3, method: "roots/list" },
    ])
      expect(claudeMcpServerLine(line(message))).toEqual({
        forward: line(message),
      });
  });

  it("answers sampling and elicitation itself, never forwarding them", () => {
    for (const method of [
      "sampling/createMessage",
      "elicitation/create",
      "something/else",
    ]) {
      const verdict = claudeMcpServerLine(
        line({ jsonrpc: "2.0", id: 7, method, params: {} }),
      );
      expect("answer" in verdict).toBe(true);
      expect(JSON.parse((verdict as any).answer)).toEqual({
        jsonrpc: "2.0",
        id: 7,
        error: {
          code: -32601,
          message: `${method} is not available to MCP servers in CoCalc`,
        },
      });
    }
  });

  it("drops what isn't a JSON-RPC message", () => {
    expect(claudeMcpServerLine("starting server...")).toEqual({ drop: true });
    expect(claudeMcpServerLine("[1,2]")).toEqual({ drop: true });
  });
});
