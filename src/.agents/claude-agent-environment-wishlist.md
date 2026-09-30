# Claude agent environment wishlist

Written by Claude (claude-opus-5-5) on 2026-09-30, working as an agent in a CoCalc project. This is a list of general gaps an agent runs into when working in a CoCalc project. None of it is specific to CoCalc development. The examples come from real work in this project.

## 1. Viewing images in the project

- **Gap:** project commands return text only. An agent can create an image (a Playwright screenshot, a matplotlib plot, a rendered PDF page) but can't look at it.
- **Example:** after changing a chat footer, I took a screenshot and had to check the result by measuring button sizes and colors from the DOM instead.
- **Wanted:** a tool that returns a project image file (PNG/JPEG/SVG, or a PDF page) as image content, the same way pasted images reach the agent. This covers "does this plot look right?", "did this UI change work?" and before/after comparisons.

## 2. Seeing what your browser sees

- **Gap:** the `cocalc browser` commands (exec, screenshot, logs, network) exist, but under agent auth `browser session list` is unavailable and no `COCALC_BROWSER_ID` is provided, so the agent can't target your tab.
- **Example:** to debug a scroll flicker, you had to paste a `console.table` from your console by hand.
- **Wanted:** a per-turn, consent-based "share this tab with the agent" action with a visible indicator, so the agent can read console output, run a measurement, or take a screenshot of what you're looking at. It should be revocable and should expire at the end of the turn.

## 3. File tools that run in the project

- **Gap:** every read and edit goes through shell commands (`sed -n` ranges, `grep`, Python heredocs doing string replacement). This works but is noisy and prone to quoting mistakes. Every command also ends with a "Remaining job processes were terminated…" line on stderr.
- **Wanted:** project-side tools to read a file with line ranges, make an exact-string edit that fails if the match isn't unique, write a whole file, and grep or glob with structured results.

## 4. Memory and transcripts the agent can reach

- **Gap:** the agent is set up to keep a persistent memory: small notes it writes (user preferences, project conventions, lessons learned) plus an index loaded at the start of every session. It is also given a pointer to the full transcript for recovering details lost when a long conversation is compacted. Both live on the agent controller's filesystem, which no tool here can read or write, so memory is effectively off.
- **Example:** every new session starts from zero. It relearns things like "verify the remote commit after every push" or "how to deploy to the test server", and it can't recover exact details after compaction.
- **Wanted:** memory and transcripts stored in a place the agent's tools can reach, such as a directory in the project or the user's home. You could also read, edit and delete the memory, which is a feature: it is auditable.

## 5. Easier artifact publishing

- **Gap:** a GitHub PR card needs `repository`, `state`, `draft`, `fetched_at`, `base_sha`, `head_sha` and `checks` assembled by hand. A wrong payload only fails with "invalid GitHub PR identity". The per-turn message date now supplied in the turn context fixed the earlier "message date required" failure.
- **Wanted:** shortcuts like `artifact publish --github-pr <number>` that fill in the fields themselves, and error messages that name the invalid field.

## 6. Your pasted images as project files

- **Gap:** images you paste into chat reach the agent, but they aren't files in the project.
- **Wanted:** save pasted attachments to a project path (for example, next to the chat file) and include that path in the turn. Then the agent can attach them to a PR or issue, keep them as test fixtures, or place them next to its own screenshot for comparison.

## 7. Resuming after long jobs

- **Gap:** a finished turn can't be woken when a job ends, so the agent waits in the foreground on every build and test run. That's fine for runs of 1–2 minutes, but it wastes the turn on long CI, end-to-end or training runs.
- **Wanted:** a way to schedule a continuation, such as "resume this thread when job X finishes (or at time T)", with the job's final status and output tail delivered as the next turn.
