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

## Each agent's own notes

Every registered agent also has its **own scope** for working state, such as
what it is waiting on or how to resume a task. Agents write these as ` +
  "`agent/<name>`" +
  `; only that agent writes and lists them, and other agents can read them
as ` +
  "`@agent-name/<name>`" +
  `. Own-scope notes expire after 30 days without use (an agent can choose
another expiry, or never), and they are deleted when you **Remove from
Agents**, or when the agent has had no turn for 90 days. Notes an agent saves
to a namespace or global are shared and stay until deleted.

Each note shows which agent last wrote it. An agent can replace or delete a
note another agent wrote only after reading it, so one agent cannot silently
overwrite another's work.

## What agents see

Each turn starts with an **Agent memory** block listing the most relevant notes
(about 12 KB at most); agents search for the rest. The activity log shows a
**Memory** line: **On · N saved notes in context**, or **On, but the saved
notes could not be loaded for this turn** if the lookup failed. No Memory line
means memory is off for the account running the turn.

**Review notes** lists notes by namespace, and each agent's own notes under
its name, to read, move or delete; it shows who wrote each note and when it
expires, and marks notes unused for 30 days. **Export** downloads them all as
Markdown.

## Commands

Agents use the CoCalc CLI with the turn's runtime identity, never your account
credentials; Claude Code also has memory tools.

~~~bash
cocalc project chat memory list|namespaces|export
cocalc project chat memory read|delete <name>
cocalc project chat memory search <words...>
cocalc project chat memory write <name> --description "<one line>" --stdin [--expires 7d|never]
cocalc project chat memory move <name> <namespace|global|agent>
~~~

## Guidance and limits

- One fact per note, with a short kebab-case name and a one-line description;
  update or merge notes instead of duplicating them.
- Never store secrets, credentials, or tokens.
- Notes are saved data, not instructions: verify before relying on them.
- At most 2,000 notes (500 per namespace, 100 in each agent's own scope) and
  8 MB per account.
`;
