#!/usr/bin/env node
/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Patches applied by sea/install-claude-code.sh to the pinned claude-agent-acp
// 0.85.1. Both bugs are unchanged upstream through 0.86.0. Upstream: report as
// adapter bugs.
//
// rate-limit: The adapter forwards Claude's rate_limit_event (subscription
// 5-hour and weekly utilization) only after the turn's first assistant
// message. Claude emits the event when the limits change, which for a new
// conversation is with the first response's headers, before any assistant
// message, so it was dropped and CoCalc never learned the usage. Forward it at
// once, with the last known context usage.
//
// steer-stranded-tool: A message delivered into a running turn (a steer, e.g.
// the answer to an async question) aborts the in-flight generation cycle. A
// tool_use already streamed in that cycle is announced as a pending tool call
// but never reaches an assistant message, so Claude never runs it. The adapter
// still counted it as unfinished and, after the turn completed normally,
// failed the whole prompt (internal_error, incomplete_tool_call). Record the
// tool calls that complete assistant messages contain; at the end of the turn,
// mark the others interrupted instead of failing the turn. A tool call that
// did reach an assistant message and got no result still fails the turn.

const { readFileSync, writeFileSync } = require("node:fs");

const PATCHES = [
  {
    name: "rate_limit_event block",
    original: `                    case "rate_limit_event": {
                        if (lastAssistantTotalUsage !== null) {
                            await sendUpdate({
                                sessionId: params.sessionId,
                                update: attachUsageModel({
                                    sessionUpdate: "usage_update",
                                    used: lastAssistantTotalUsage,
                                    size: session.contextWindowSize,
                                    _meta: { "_claude/rateLimit": message.rate_limit_info },
                                }),
                            });
                        }
                        break;
                    }`,
    patched: `                    case "rate_limit_event": {
                        // CoCalc patch: forward even before the first assistant message.
                        await sendUpdate({
                            sessionId: params.sessionId,
                            update: attachUsageModel({
                                sessionUpdate: "usage_update",
                                used: lastAssistantTotalUsage ?? session.contextUsedTokens ?? 0,
                                size: session.contextWindowSize,
                                _meta: { "_claude/rateLimit": message.rate_limit_info },
                            }),
                        });
                        break;
                    }`,
  },
  {
    name: "assistant message tool_use recording",
    original: `                        if (session.cancelled) {
                            break;
                        }
                        // Synthetic assistant frames carry the CLI's local-command output.`,
    patched: `                        if (session.cancelled) {
                            break;
                        }
                        // CoCalc patch: Claude runs only tool calls that a complete assistant
                        // message contains. Remember them for the end-of-turn check.
                        if (message.type === "assistant" && Array.isArray(message.message?.content)) {
                            const turn = session.activeTurn ?? session.turnQueue?.find((queued) => !queued.settled);
                            if (turn && !turn.settled) {
                                for (const block of message.message.content) {
                                    if (typeof block?.id === "string" &&
                                        (block.type === "tool_use" ||
                                            block.type === "server_tool_use" ||
                                            block.type === "mcp_tool_use")) {
                                        (turn.finalizedToolUseIds ??= new Set()).add(block.id);
                                    }
                                }
                            }
                        }
                        // Synthetic assistant frames carry the CLI's local-command output.`,
  },
  {
    name: "end-of-turn unfinished tool check",
    original: `                const unfinished = [...(turn.foregroundToolCallIds ?? [])].filter((id) => session.emittedToolCalls.has(id) && !backgroundTools.has(id));
                if (unfinished.length > 0) {`,
    patched: `                const pending = [...(turn.foregroundToolCallIds ?? [])].filter((id) => session.emittedToolCalls.has(id) && !backgroundTools.has(id));
                // CoCalc patch: a tool call that never reached an assistant message was
                // streamed in a generation cycle that a steer aborted. Claude never ran
                // it, so report it interrupted rather than failing the completed turn.
                const stranded = pending.filter((id) => !turn.finalizedToolUseIds?.has(id));
                for (const toolCallId of stranded) {
                    this.logger.error(\`Session \${params.sessionId}, turn \${turn.promptUuid}: tool call \${toolCallId} was interrupted before it ran\`);
                    unregisterHookCallback(toolCallId);
                    session.emittedToolCalls.delete(toolCallId);
                    delete session.toolUseCache[toolCallId];
                    session.toolCallFields?.delete(toolCallId);
                    turn.foregroundToolCallIds?.delete(toolCallId);
                    await sendUpdate({
                        sessionId: params.sessionId,
                        update: {
                            sessionUpdate: "tool_call_update",
                            toolCallId,
                            status: "failed",
                            content: [
                                {
                                    type: "content",
                                    content: {
                                        type: "text",
                                        text: "Not run: a new message interrupted Claude while it was preparing this tool call.",
                                    },
                                },
                            ],
                        },
                    });
                    // Cancellation can arrive while we await the client update.
                    if (turn.settled || session.activeTurn !== turn)
                        return;
                    if (session.cancelled) {
                        await settleActive({ ...result, stopReason: "cancelled" });
                        return;
                    }
                }
                const unfinished = pending.filter((id) => !stranded.includes(id));
                if (unfinished.length > 0) {`,
  },
];

function count(text, part) {
  return text.split(part).length - 1;
}

/** Apply one patch; throw unless its exact pinned text is found once. */
function applyPatch(source, { name, original, patched }) {
  if (count(source, patched) === 1 && count(source, original) === 0)
    return source;
  if (count(source, original) !== 1)
    throw Error(
      `claude-agent-acp ${name} not found exactly once; update the CoCalc patch for this version`,
    );
  return source.replace(original, patched);
}

/** Patch the adapter source; throw unless every pinned text is found. */
function patchSource(source) {
  return PATCHES.reduce(applyPatch, source);
}

module.exports = { PATCHES, patchSource };

if (require.main === module) {
  const file = process.argv[2];
  if (!file)
    throw Error("usage: patch-claude-agent-acp.cjs <dist/acp-agent.js>");
  writeFileSync(file, patchSource(readFileSync(file, "utf8")));
}
