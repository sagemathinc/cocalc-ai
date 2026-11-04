/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Framing and policy for relaying a user's MCP server (stdio, newline-
// delimited JSON-RPC) to a Claude agent. Pure, so the host relay and its
// tests share it.

/** Longest line either way (like the CoCalc tool transport's limit). */
export const MAX_MCP_LINE_BYTES = 1_200_000;

/** Server-initiated requests a relayed server may make: nothing that spends
 * the subscription (sampling) or asks the person (elicitation). */
const ALLOWED_SERVER_REQUESTS = new Set(["ping", "roots/list"]);

let encoder: TextEncoder | undefined;
// Whether value's UTF-8 encoding is longer than max bytes. A UTF-16 unit
// encodes to 1-3 bytes, so most values need no encoding to tell.
const tooLong = (value: string, max: number): boolean =>
  value.length > max ||
  (value.length * 3 > max &&
    (encoder ??= new TextEncoder()).encode(value).length > max);

/** Splits a stream into lines, refusing one longer than the limit. */
export class McpLineSplitter {
  private buffer = "";
  constructor(private readonly maxBytes = MAX_MCP_LINE_BYTES) {}

  /** The complete lines in `chunk` (without newlines, empty ones dropped). */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (tooLong(line, this.maxBytes))
        throw new Error("MCP message too large");
      if (line.trim()) lines.push(line);
    }
    if (tooLong(this.buffer, this.maxBytes))
      throw new Error("MCP message too large");
    return lines;
  }
}

export type ServerLineVerdict =
  /** Pass to the agent unchanged. */
  | { forward: string }
  /** Don't pass it on; answer the server with this line. */
  | { answer: string }
  /** Not JSON-RPC: drop it. */
  | { drop: true };

/** What to do with one line from the server. */
export function claudeMcpServerLine(line: string): ServerLineVerdict {
  let message: any;
  try {
    message = JSON.parse(line);
  } catch {
    return { drop: true };
  }
  if (!message || typeof message !== "object" || Array.isArray(message))
    // Batches are not part of current MCP; refuse rather than inspect.
    return { drop: true };
  // A request is a method with an id member, whatever its value (even null):
  // the sender waits for an answer.
  const isRequest =
    typeof message.method === "string" &&
    Object.prototype.hasOwnProperty.call(message, "id");
  if (isRequest && !ALLOWED_SERVER_REQUESTS.has(message.method))
    return {
      answer: JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: `${message.method} is not available to MCP servers in CoCalc`,
        },
      }),
    };
  return { forward: line };
}
