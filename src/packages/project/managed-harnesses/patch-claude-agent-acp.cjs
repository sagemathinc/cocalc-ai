#!/usr/bin/env node
/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Patches applied by sea/install-claude-code.sh to the pinned claude-agent-acp
// 0.93.0. Upstream: report as adapter bugs.
//
// rate-limit: The adapter forwards Claude's rate_limit_event (subscription
// 5-hour and weekly utilization) only after the turn's first assistant
// message. Claude emits the event when the limits change, which for a new
// conversation is with the first response's headers, before any assistant
// message, so it was dropped and CoCalc never learned the usage. Forward it at
// once, with the last known context usage.
//
// steer-next: The adapter delivers guidance (steers) with priority "now",
// which aborts Claude's current generation: a partly written answer or tool
// call is thrown away and Claude starts over. Claude Code itself queues
// messages typed while it works with priority "next", which waits for the
// current step to finish. Use "next" so CoCalc guidance behaves the same way.
// Verified live with Claude Code 2.1.286: "now" cut a streamed answer off and
// Claude rewrote it from scratch; "next" let it finish, then followed the
// guidance.
//
// Fixed upstream by 0.93.0, so no longer patched here: a steer that stranded
// a streamed tool_use (never part of a complete assistant message) failed the
// whole turn (incomplete_tool_call); the adapter now closes such a call as
// abandoned instead.

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
    name: "steer delivery priority",
    original: `        userMessage.priority =
            (session.openUserInputs?.size ?? 0) > 0 ? STEER_PRIORITY_LATER : STEER_PRIORITY_NOW;`,
    patched: `        // CoCalc patch: deliver guidance at the next step boundary, as Claude Code
        // does for messages typed while it works, instead of aborting the current
        // generation. A pending permission prompt still defers it further.
        userMessage.priority =
            (session.openUserInputs?.size ?? 0) > 0 ? STEER_PRIORITY_LATER : "next";`,
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
