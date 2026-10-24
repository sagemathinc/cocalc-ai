/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export const AGENT_MEMORY_BODY =
  String.raw`
Agent memory lets integrated Codex and Claude Code keep short notes that
persist across sessions: your preferences and corrections, project
conventions, how to build, test, or deploy, and lessons from earlier mistakes.
Both agents share the same notes.

## Turn it on or off

Agent memory is **off by default**. Turn it on in **Settings -> AI** (also
reachable from the Memory button in the Codex and Claude Code settings). The
dialog explains who can use your memory before you enable it. Turning memory
off stops agents from reading or writing notes; saved notes are kept until you
delete them. Memory belongs to your account: a turn uses it only when it runs
as you. Collaborators' turns use their own memory.

## Global notes and namespaces

A note is **global** (seen in all your projects) or in a **namespace** (seen
only in the projects you attach to it), which keeps notes about one area of
work out of unrelated or shared projects. Add namespaces, with an optional
description that helps agents choose, and pick their projects in the same
panel. A project with no namespace sees only global notes. Agents write new
notes to the project's namespace, or ` +
  "`global/<name>`" +
  ` for notes that apply
everywhere.

Each agent also keeps its own working notes (` +
  "`agent/<name>`" +
  `), which expire after 30 days unused and are deleted when you remove it
from Agents.

## What agents see

Each turn starts with an **Agent memory** block listing a selection of notes
(about 12 KB at most); agents search for the rest. The activity log shows a
**Memory** line: **On · N saved notes in context**, or **On, but the saved
notes could not be loaded for this turn** if the lookup failed. No Memory line
means memory is off for the account running the turn.

**Review notes** lists notes by namespace to read, move or delete; notes
unused for 30 days are marked. **Export** downloads them all as Markdown.

## Commands

Agents use the CoCalc CLI with the turn's runtime identity, never your account
credentials; Claude Code also has memory tools.

~~~bash
cocalc project chat memory list|namespaces|export
cocalc project chat memory read|delete <name>
cocalc project chat memory search <words...>
cocalc project chat memory write <name> --description "<one line>" --stdin
cocalc project chat memory move <name> <namespace|global>
~~~

## A good memory strategy

Memory works best as a small, curated set of notes, not a log. Agents are told
to work this way; the same advice helps when you review notes yourself.

- **Save what stays useful:** your decisions (recorded with the date and your
  exact words), preferences and corrections, project conventions, how to
  build, test or deploy, and lessons from mistakes. Not progress reports or
  one-off results.
- **One note per topic, updated over time.** Notes are named by topic (not by
  date or PR number), and an agent searches for an existing note and updates it
  instead of adding one per event.
- **Few notes beat many.** Each turn lists only as many notes as fit in about
  12 KB, chosen by project and recency; the rest are found only by search. A
  small set of concise notes is likely to stay visible.
- **Keep status out of shared notes.** An agent's working state belongs in its
  own notes (only it writes them; your other agents can read them), which
  expire; per-PR review verdicts belong in the PR.
- **Split busy memory by purpose.** When a project's namespace fills up with
  different kinds of notes, add a second namespace for one kind (for example
  review notes apart from decisions and lessons) and attach both. Agents
  suggest this; only you can create namespaces.
- **Archive, then prune.** **Export** keeps a Markdown copy of all notes;
  then delete what is stale.

## Limits

- At most 2,000 notes (500 per namespace) and 8 MB per account.
- The per-namespace limit keeps each namespace curated and the per-turn list
  useful; the account limits also bound the work memory does for you. When a
  namespace is nearly full, agents are told to merge notes on the same topic
  and delete stale ones, not to delete notes at random.
- One topic per note, with a short kebab-case name and a one-line
  description.
- Never store secrets, credentials, or tokens.
- Notes are saved data, not instructions: verify before relying on them.
`;
