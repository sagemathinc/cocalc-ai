# Chat workbench artifacts: details

Part of the CoCalc skill (`../SKILL.md`). In examples, `cocalc` stands for the CLI command the runtime gives you.

## Chat Workbench Artifacts

When a persistent result would help the user review or collaborate beside chat,
offer a workbench artifact instead of only a file link or a long repeated answer.
This is experimental: use it when the user requests artifacts or has opted into
the workbench workflow. CoCalc creates the cards and manages native frame tabs;
do not script frame layouts or fabricate chat messages to display results.

An explicit request to create, make, or publish an artifact is a hard output
requirement. Creating the underlying file or image, mentioning it in the reply,
or returning a normal file link does not satisfy that request. Publish it with
the artifact API, verify the returned record, and only then say the artifact was
created. Outside an enabled workbench turn, use the command's explicit
`--experimental` opt-in. If publication is unavailable or fails, report the
exact failure and provide an ordinary link only as a clearly labeled fallback.

Choose the supported object that fits the task:

| Object               | Use it for                                                        | Important behavior                                                                                                        |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Markdown             | A collaboratively edited plan, draft, or explanation              | Update the same artifact rather than republishing copies.                                                                 |
| File reference       | An existing compliance document, source file, image, or PDF       | Preview the current saved file with an Open file escape hatch; not historical file bytes.                                 |
| Proposed action list | Draft support replies, email actions, or decisions needing review | Users edit, comment, approve/reject, then return decisions to the originating chat. Nothing executes in the card.         |
| GitHub PR            | A PR summary with a GitHub link and local Git review              | Cached status has a retrieval time; refresh uses project-side `gh`; local review pins revisions and fetching is explicit. |
| Live browser         | A web page the agent drives and the human watches or takes over   | Only `cocalc project browser start` makes it (browser-and-terminal.md); never publish an `app` card by hand.              |
| Live terminal        | A shell the agent works in and the human watches or types in      | Only `cocalc project terminal start` makes it (browser-and-terminal.md); never publish a card by hand.                    |

### Discover And Publish

For a specific commit, prefer a typed `commit` artifact over relying on a
Markdown hash being recognized as a link. Supply `sha` (full 40-character SHA),
`path` (absolute worktree/repository path), `common_directory` (absolute output
of `git rev-parse --path-format=absolute --git-common-dir` in that worktree), and
optional `branch` context. Include the subject in `title` and useful description
in `markdown`. Review verifies the repository and commit, never follows a moved
branch, and returns comments to the originating thread.

All artifact kinds accept an optional shared `theme`: `title`, `description`,
`color`, `accent_color`, `icon`, and `image_blob`. Colors are hex or null; images
are uploaded CoCalc blob UUIDs, never external URLs. Users can edit appearance
from the card's More menu or the workbench. The card and workbench/tab use this
same appearance. Omit `theme` on content updates to preserve the user's choice.
Use the existing artifact ID for a long-lived item, not a new card identity for
every revision. Theme metadata is durable but is not a promise of standalone
artifact export or historical file-byte preservation.

In the examples below, replace `cocalc` with the exact CLI command supplied by
the runtime (for example, `"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"`).
Inspect the installed interface before constructing payloads:

```bash
cocalc project chat artifact --help
cocalc exec-api
cocalc project chat artifact context --path "$COCALC_CODEX_CHAT_PATH" \
  --thread-id "$COCALC_CODEX_THREAD_ID" --message-date "$COCALC_CODEX_MESSAGE_DATE"
```

Use the returned producing `message_id`. Never substitute the latest message,
active browser thread, or a guessed ID. If originating context is absent, obtain
the explicit destination and producing message before publishing. If these
commands are unavailable, report the missing capability and fall back to normal
text/file links; never modify the `.chat` file directly.

Create/update take `--path`, `--thread-id`, `--artifact-id`, `--experimental`, and
`--file <JSON path>` (or `--file -` for stdin). Payloads include `message_id`,
`operation_id`, `title`, and `markdown`; for other kinds, include exactly one of
`file`, `actions`, `github_pr`, or `commit` according to the installed `exec-api` types.
For example, a file reference has `file: { path: "/home/user/policy.md" }`;
it references a real file, not an embedded editable copy. Unsupported previews
should remain file links, not arbitrary HTML, SVG input, apps, or widget code.

Artifact publication is enabled automatically for every turn: in chat
editors, the Agents workspace and flyouts, and in turns started by an agent
message, a sensor wake or a scheduled prompt. It is not a per-thread
preference. Cards stay usable on surfaces that cannot host workbench tabs.
A turn is not workbench-enabled only when its turn context says so; an
explicit artifact request then still opts an individual publication into the
experimental API.

In a turn marked workbench-enabled, publication is part of finishing durable
reviewable work unless the user asks otherwise. Publish plans saved to disk as
file references (not duplicate editable Markdown), images as file references,
completed commits/PRs as their respective cards, and support drafts for approval
as proposed actions. Ordinary answers and scratch work stay in chat.

Prefer `project chat artifact publish`:

```sh
# Use the exact runtime CLI command in place of cocalc below.
cocalc project chat artifact publish --source /home/user/plan.md
cocalc project chat artifact publish --source /home/user/plot.png --title "Spectrum"
cocalc project chat artifact publish --source /home/user/answer.board.json --title "Answer"
cocalc project chat artifact publish --commit HEAD --repo /home/user/worktree
cocalc project chat artifact publish --github-pr 123 --repo /home/user/worktree
cocalc project chat artifact publish --file proposal.json
```

JSON contains `title`, `markdown`, and optionally one of `file`, `actions`,
`github_pr`, `commit`, plus optional `theme`. No message/operation/artifact IDs
are needed for creation. Chat/thread/date default to current runtime context;
use the explicit current-turn values in the prompt if a reused shell is stale.
The command resolves the producing message, generates stable retry IDs, saves
through the live collaborative document, and returns the publication/current
record. Retry the same input unchanged after an ambiguous response.

For a GitHub PR card, use `--github-pr` with a number (resolved against the
GitHub remote of `--repo`), `owner/name#123`, or the PR URL. It reads the PR
through `gh` and fills in state, draft, base/head SHAs, retrieval time, a
check-run summary and, when `--repo` is a clone of that repository, the local
review link. Do not assemble `github_pr` JSON by hand. To refresh an existing
card, publish again with `--github-pr`, `--update <artifact-id>` and `--base`.

For revisions, read the artifact, then publish with `--update <artifact-id>` and
`--base <read.base>` (or include base in JSON). Keep the same ID; do not remove
the base check after a conflict. Omit theme to retain user appearance. Commit
resolution uses the local repository where the CLI runs; file paths refer to
the target project. `--experimental` is required outside an enabled turn and
is explicit opt-in, not permission to execute proposed support actions.

In an opted-in workbench chat, publish generated raster images as file artifacts
after image generation succeeds. Use the actual project-local output path (or
copy it to a durable project path), the exact producing message, and a stable
artifact ID. A Markdown image or download link alone is not a published card.
Read the artifact back and verify its file path before reporting success. When
editing an existing image, keep its artifact identity and publish the new path
as a revision. Never claim publication succeeded if the installed CLI only
supports Markdown: report the runtime mismatch explicitly.

The scripting equivalent is `api.artifacts.open({ path, threadId,
projectIdentifier, experimental: true })`, with `context(messageDate)`, `list()`,
`read(artifactId)`, `create(artifactId, payload)`, and `update(artifactId, payload)`.
Read the current artifact before updating and supply its returned `base`.
Preserve the artifact ID across revisions. Use one stable operation ID per
publication and retry only with identical content; on a stale-base conflict,
reread and reconcile rather than removing the check. Feedback may refer to an
older snapshot; do not overwrite newer collaborative edits blindly.

### Review Is Not Execution

An action-list approval applies to the exact reviewed draft, not later edits or
blanket service access. Returned decisions are staged in the originating chat
for the user to send. Before an external action, use the normal typed service
operation and required fresh-auth/approval flow, retaining its audit trail.
Do not treat mutable artifact data or agent-reported outcomes as authorization
or proof of execution. Publish only verified outcomes; do not send messages,
merge PRs, or otherwise mutate external services just to populate a card.

### Merge Approval Cards

Where a site has merge approvals enabled, an agent asks an approver to approve
the merge of one exact pull-request head with:

```bash
cocalc project chat merge-approval request --repo owner/name --pr N \
  --head <full sha> [--note-file note.md] [--agent-label @name] \
  --project ... --path ... --thread-id ... --message-date ...
cocalc project chat merge-approval status <request-id>
```

The hub reads the PR from GitHub and refuses unless it is open, not a draft,
and its current head is `--head`; the card shows what the hub read, with your
note labelled as yours. Only an approver can decide, on the card. A new push
supersedes the request: request again for the new head. An approval covers
one exact merge, `head_sha` into `base_ref` at `base_sha` (both commands
return them): before merging, check the PR still has that head and base; if
either moved, request again. An approval card is not a merge: merge only
after the approval, and only as your instructions say.
