# Claude agent environment wishlist

Written by Claude (claude-opus-5-5) on 2026-09-30, working as an agent in a CoCalc project. This is a list of general gaps an agent runs into when working in a CoCalc project. None of it is specific to CoCalc development. The examples come from real work in this project. Items 9–12, and the notes marked "second report", come from another Claude's notes from work in a different project (October 2026).

## 1. Viewing images in the project

**Status:** implemented as the `project_read_image` subscription tool (see below).

- **Gap:** project commands return text only. An agent can create an image (a Playwright screenshot, a matplotlib plot, a rendered PDF page) but can't look at it.
- **Example:** after changing a chat footer, I took a screenshot and had to check the result by measuring button sizes and colors from the DOM instead.
- **Wanted:** a tool that returns a project image file (PNG/JPEG/SVG, or a PDF page) as image content, the same way pasted images reach the agent. This covers "does this plot look right?", "did this UI change work?" and before/after comparisons.
- **Implemented:** `project_read_image` (in `project-host/acp/claude-project-mcp.cjs` and `claude-project-tool-bridge.ts`) reads PNG, JPEG, GIF or WebP files up to 800 KB with the same project authority as `project_exec`, detects the type from the file bytes, and returns an MCP `image` block. SVG and PDF need rendering to PNG first.

## 2. Seeing what your browser sees

- **Gap:** the `cocalc browser` commands (exec, screenshot, logs, network) exist, but under agent auth `browser session list` is unavailable and no `COCALC_BROWSER_ID` is provided, so the agent can't target your tab.
- **Example:** to debug a scroll flicker, you had to paste a `console.table` from your console by hand.
- **Wanted:** a per-turn, consent-based "share this tab with the agent" action with a visible indicator, so the agent can read console output, run a measurement, or take a screenshot of what you're looking at. It should be revocable and should expire at the end of the turn.

## 3. File tools that run in the project

**Status:** implemented as `project_read_file`, `project_edit_file` and `project_write_file`.

- **Gap:** every read and edit goes through shell commands (`sed -n` ranges, `grep`, Python heredocs doing string replacement). This works but is noisy and prone to quoting mistakes. (The stray stderr line on every command is item 10.)
- **Wanted:** project-side tools to read a file with line ranges, make an exact-string edit that fails if the match isn't unique, write a whole file, and grep or glob with structured results.
- **Implemented:** `project-host/acp/claude-project-file-tools.ts`. Reads return numbered lines with offset/limit (256 KB per call, binary refused). Edits are exact-string replacements that must be unique unless `replace_all`, written atomically and refused if the file changed meanwhile. Writes are atomic, keep the existing mode, follow symlinks and accept up to 1 MB. All three run through the same scoped executor as `project_exec`. There is no separate grep/glob tool yet; `rg` through `project_exec` covers it.

## 4. Memory and transcripts the agent can reach

**Status:** memory implemented (account-scoped, loaded only for the launching account's turns, index in the session instructions, `memory_*` tools). Transcripts are not done yet.

- **Gap:** the agent is set up to keep a persistent memory: small notes it writes (user preferences, project conventions, lessons learned) plus an index loaded at the start of every session. It is also given a pointer to the full transcript for recovering details lost when a long conversation is compacted. Both live on the agent controller's filesystem, which no tool here can read or write, so memory is effectively off.
- **Example:** every new session starts from zero. It relearns things like "verify the remote commit after every push" or "how to deploy to the test server", and it can't recover exact details after compaction.
- **Wanted:** memory and transcripts stored in a place the agent's tools can reach, such as a directory in the project or the user's home. You could also read, edit and delete the memory, which is a feature: it is auditable.

## 5. Easier artifact publishing

- **Gap:** a GitHub PR card needs `repository`, `state`, `draft`, `fetched_at`, `base_sha`, `head_sha` and `checks` assembled by hand. A wrong payload only fails with "invalid GitHub PR identity". The per-turn message date now supplied in the turn context fixed the earlier "message date required" failure.
- **Wanted:** shortcuts like `artifact publish --github-pr <number>` that fill in the fields themselves, and error messages that name the invalid field.
- **Confusing date:** published artifact and publication records show `"date": "1970-01-01T00:00:00.000Z"`, while the real time is in `published_at`. Several Claude instances have reported this as a bug, then found in the code that it is intentional. In the chat document, `date` is part of each row's primary key, and artifact rows use a fixed sentinel date (`chat/src/artifacts.ts`) so that each artifact stays one row that is updated in place. The CLI then returns that storage row unchanged.
- **Wanted:** don't expose the storage key in what the CLI and API return. Omit `date` from artifact and publication results, or replace it with the real `published_at`/`updated_at` times, so the output never shows a fake timestamp.

## 6. Your pasted images as project files

**Status:** implemented for harness agents (Claude) running in the project container.

- **Gap:** images you paste into chat reach the agent, but they aren't files in the project.
- **Wanted:** save pasted attachments to a project path (for example, next to the chat file) and include that path in the turn. Then the agent can attach them to a PR or issue, keep them as test fixtures, or place them next to its own screenshot for comparison.
- **Implemented:** pasted images were already written into the project for each turn, but under a temporary directory deleted at the end of the turn, and Claude was never told the paths. They are now kept in `~/.local/share/cocalc/chat-attachments/` (named by blob UUID, pruned after 14 days), and the prompt lists each `[Attached image N]` with its project path (`lite/hub/acp/blob-materialization.ts`).

## 7. Resuming after long jobs

- **Gap:** a finished turn can't be woken when a job ends, so the agent waits in the foreground on every build and test run. That's fine for runs of 1–2 minutes, but it wastes the turn on long CI, end-to-end or training runs.
- **Wanted:** a way to schedule a continuation, such as "resume this thread when job X finishes (or at time T)", with the job's final status and output tail delivered as the next turn.

## 8. Subagents

- **Gap:** Claude Code can hand work to subagents (its Agent tool). Each one runs in parallel with its own context window and reports back a summary. In CoCalc they aren't available. The subscription controller starts every session with all built-in Claude Code tools off (`tools: []` and `agents: {}` in `claudeSubscriptionSessionMeta`, `ai/acp/harness-client.ts`). Only the CoCalc project tools remain, so the Agent tool doesn't exist.
- **Example:** broad, independent investigations had to run one after another in the main context and use it up. Examples include auditing every JSON-lines reader for the U+2028 hang and reviewing a 48-file PR while also reading the code it changed. Subagents would have searched in parallel and returned just the findings.
- **Wanted:**
  - Enable only the Agent tool, keeping the other built-in tools off.
  - Subagents use the same project tool server (`project_exec` and the file tools) with the same scoped authority as the parent turn.
  - Their activity appears in the turn's activity log.
  - A cap on how many run at once.
  - Stop cancels them together with the parent.
  - They count against the same subscription usage, which should be stated wherever subagents are mentioned.
- **Second report:** the other Claude also found no subagent or parallel-agent tool; its only parallelism was running several jobs at once. `/opt/cocalc/bin2/codex` exists in the project, but it has no credentials unless someone signs in manually inside the project, which saves a credential to `~/.codex/auth.json`. Normal CoCalc Codex turns don't use that file and don't store any credential in the project. So it is not a way for an agent to start helpers.

## 9. Large tool calls

- **Gap:** a `project_exec` call whose script was a ~40 KB heredoc failed with "Project tool disconnected" and wrote nothing. Sending the same content as two ~25 KB calls worked.
- **Cause:** on `main`, the project tool bridge accepts at most 40 KB per request (`MAX_REQUEST_BYTES` in `project-host/acp/claude-project-tool-bridge.ts`). Anything larger makes it close the connection without a reply, and the MCP helper reports that as "Project tool disconnected". This PR raises the limit to 2.5 MB for the file tools, but an oversized request is still dropped silently.
- **Wanted:** an explicit error that names the limit and says to split the call. #816 does this for the MCP helper's own line limit.
- **Implemented:** the bridge now answers an oversized request with "Project tool request too large: over 2500000 bytes. Split it into smaller calls (for example, write a large file in parts)." The connection is no longer dropped, and the next call works normally.

## 10. A stray stderr line on every command

- **Gap:** nearly every job, even `ls`, ends with "Remaining job processes were terminated when the command exited; use cocalc project terminal spawn for persistent services." It reads like a warning about something the agent did. It appears in almost every result, both reports saw it, and it costs tokens.
- **Cause:** the project's job runner prints it whenever processes remain in the job's scope after the command exits (`server/cloud/bootstrap/bootstrap.py`). Since it appears for commands that start nothing in the background, something the wrapper or shell startup itself runs is probably being counted.
- **Wanted:** print it only when processes the command itself started were killed, and name them, for example "terminated 2 leftover processes: sleep, node".

## 11. Job progress for long-running commands

- **Gap:** while a long build runs, `project_exec_wait` returns nothing new until output arrives. If the output is buffered (for example piped through `tail`), "is it stuck or busy?" means running `ps` in a second call.
- **Wanted:** wait results that include the job's CPU time and how long ago it last produced output.

## 12. Small gaps in the project image

- **Gap:** `/usr/bin/time` is not installed (the bash `time` keyword works). Benchmark scripts commonly use `/usr/bin/time -v`.
- **Wanted:** include GNU `time` in the default image.

## What already works well

The second report also noted what worked smoothly:

- `request_user_input_async`: the answer arrived as a new user message mid-turn.
- `gh` was already authenticated (ssh protocol), and repo create and push worked.
- `ssh` to other hosts with BatchMode worked.
- The npm registry and pnpm store were reachable.
- Artifact publishing worked for file and commit cards.
