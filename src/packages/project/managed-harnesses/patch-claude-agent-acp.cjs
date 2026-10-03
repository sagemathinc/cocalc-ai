#!/usr/bin/env node
/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Patch applied by build-harnesses.sh to the pinned claude-agent-acp 0.81.1.
//
// The adapter forwards Claude's rate_limit_event (subscription 5-hour and
// weekly utilization) only after the turn's first assistant message. Claude
// emits the event when the limits change, which for a new conversation is
// with the first response's headers, before any assistant message, so it was
// dropped and CoCalc never learned the usage. Forward it at once, with the
// last known context usage. Upstream: report as an adapter bug.

const { readFileSync, writeFileSync } = require("node:fs");

const ORIGINAL = `                    case "rate_limit_event": {
                        if (lastAssistantTotalUsage !== null) {
                            await sendUpdate({
                                sessionId: message.session_id,
                                update: attachUsageModel({
                                    sessionUpdate: "usage_update",
                                    used: lastAssistantTotalUsage,
                                    size: session.contextWindowSize,
                                    _meta: { "_claude/rateLimit": message.rate_limit_info },
                                }),
                            });
                        }
                        break;
                    }`;

const PATCHED = `                    case "rate_limit_event": {
                        // CoCalc patch: forward even before the first assistant message.
                        await sendUpdate({
                            sessionId: message.session_id,
                            update: attachUsageModel({
                                sessionUpdate: "usage_update",
                                used: lastAssistantTotalUsage ?? session.contextUsedTokens ?? 0,
                                size: session.contextWindowSize,
                                _meta: { "_claude/rateLimit": message.rate_limit_info },
                            }),
                        });
                        break;
                    }`;

function count(text, part) {
  return text.split(part).length - 1;
}

/** Patch the adapter source; throw unless the exact pinned text is found. */
function patchSource(source) {
  if (count(source, PATCHED) === 1 && count(source, ORIGINAL) === 0)
    return source;
  if (count(source, ORIGINAL) !== 1)
    throw Error(
      "claude-agent-acp rate_limit_event block not found exactly once; update the CoCalc patch for this version",
    );
  return source.replace(ORIGINAL, PATCHED);
}

module.exports = { ORIGINAL, PATCHED, patchSource };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) throw Error("usage: patch-claude-agent-acp.cjs <dist/acp-agent.js>");
  writeFileSync(file, patchSource(readFileSync(file, "utf8")));
}
