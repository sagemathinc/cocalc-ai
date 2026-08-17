/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { getMountedIntermediateResponseMarkdown } from "@cocalc/chat";
import type {
  AcpStreamEvent,
  AcpStreamMessage,
} from "@cocalc/conat/ai/acp/types";

const MAX_TERMINAL_OUTPUT = 24_000;

type TerminalActivity = {
  terminalId: string;
  command?: string;
  args?: string[];
  cwd?: string;
  output: string;
  truncated?: boolean;
  exitCode?: number;
  signal?: string;
};

function stripAnsi(value: string): string {
  // Covers CSI color/control sequences emitted by normal terminal commands.
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function boundedOutput(value: string): string {
  const output = stripAnsi(value).trimEnd();
  if (output.length <= MAX_TERMINAL_OUTPUT) return output;
  const half = Math.floor(MAX_TERMINAL_OUTPUT / 2);
  return `${output.slice(0, half)}\n\n… output shortened on mobile …\n\n${output.slice(-half)}`;
}

function fenced(value: string, language = ""): string {
  const fence = value.includes("```") ? "````" : "```";
  return `${fence}${language}\n${value}\n${fence}`;
}

function terminalCommand(terminal: TerminalActivity): string | undefined {
  const command = `${terminal.command ?? ""}`.trim();
  const args = (terminal.args ?? [])
    .map((arg) => `${arg}`)
    .join(" ")
    .trim();
  return [command, args].filter(Boolean).join(" ") || undefined;
}

function terminalMarkdown(terminal: TerminalActivity): string | undefined {
  const command = terminalCommand(terminal);
  const output = boundedOutput(terminal.output);
  if (!command && !output) return undefined;
  const context = [
    terminal.cwd ? `cwd ${terminal.cwd}` : undefined,
    terminal.exitCode != null ? `exit ${terminal.exitCode}` : undefined,
    terminal.signal ? `signal ${terminal.signal}` : undefined,
    terminal.truncated ? "output truncated" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return [
    "**Terminal**",
    context || undefined,
    command ? fenced(command, "sh") : undefined,
    output ? `Output\n\n${fenced(output)}` : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function recordTerminalEvent(
  event: Extract<AcpStreamEvent, { type: "terminal" }>,
  terminals: Map<string, TerminalActivity>,
): void {
  let terminal = terminals.get(event.terminalId);
  if (!terminal || event.phase === "start") {
    terminal = {
      terminalId: event.terminalId,
      command: event.command,
      args: event.args,
      cwd: event.cwd,
      output: "",
      truncated: event.truncated,
    };
    terminals.set(event.terminalId, terminal);
  }
  terminal.command = event.command ?? terminal.command;
  terminal.args = event.args ?? terminal.args;
  terminal.cwd = event.cwd ?? terminal.cwd;
  terminal.truncated = event.truncated ?? terminal.truncated;
  if (event.phase === "data") {
    terminal.output += event.chunk ?? "";
  } else if (event.phase === "exit") {
    if (event.output != null) terminal.output = event.output;
    terminal.exitCode = event.exitStatus?.exitCode;
    terminal.signal = event.exitStatus?.signal;
  }
}

/**
 * Produce the compact, browser-neutral activity body used by native clients.
 * The full web activity inspector remains richer; this projection deliberately
 * preserves intermediate agent text and terminal input/output across reopen.
 */
export function projectAcpActivityMarkdown(
  events: readonly AcpStreamMessage[],
): string | undefined {
  const terminals = new Map<string, TerminalActivity>();
  const errors: string[] = [];
  for (const message of events) {
    if (message.type === "error" && message.error.trim()) {
      errors.push(message.error.trim());
    } else if (message.type === "event" && message.event.type === "terminal") {
      recordTerminalEvent(message.event, terminals);
    }
  }

  const intermediate = getMountedIntermediateResponseMarkdown([...events]);
  const blocks = [
    intermediate ? `**Codex activity**\n\n${intermediate}` : undefined,
    ...[...terminals.values()].map(terminalMarkdown),
    ...errors.map((error) => `**Activity error**\n\n${error}`),
  ].filter((block): block is string => Boolean(block));
  return blocks.length ? blocks.join("\n\n---\n\n") : undefined;
}

export function mergeAcpActivityEvents(
  previous: readonly AcpStreamMessage[],
  incoming: readonly AcpStreamMessage[],
): AcpStreamMessage[] {
  const bySequence = new Map<number, AcpStreamMessage>();
  for (const event of [...previous, ...incoming]) {
    bySequence.set(event.seq, event);
  }
  return [...bySequence.values()].sort((a, b) => a.seq - b.seq);
}
