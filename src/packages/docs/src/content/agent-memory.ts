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
off stops agents from reading or writing notes; the saved notes are kept until
you delete them, and you can review and delete them in the same panel.

Memory belongs to your account. A turn uses your memory only when it runs as
you, for example a message you send, or an Agent Networks message that starts a
turn as you. Collaborators' turns use their own memory, not yours.

## Global notes and namespaces

A note is either **global**, seen in every one of your projects, or in a
**namespace**, seen only in the projects you attach to that namespace. Use
namespaces to keep notes about one area of work (for example one product) out
of unrelated projects, and out of projects you share with others.

In **Settings -> AI -> Agent memory -> Namespaces**, add a namespace with a
name and an optional description (the description helps agents decide where a
note belongs), then choose the projects that see it. Several projects can share
a namespace, and a project can have several. A project with no namespace sees
only your global notes. Nothing changes until you add a namespace: all notes
start out global.

Agents name notes ` +
  "`name`" +
  `, ` +
  "`namespace/name`" +
  ` or ` +
  "`global/name`" +
  `. An existing
note is updated where it is. A new note goes to the project's namespace when it
has exactly one; agents write ` +
  "`global/<name>`" +
  ` for notes that apply everywhere,
such as your general preferences.

## What agents see

When memory is on, each turn starts with an **Agent memory** block listing the
most relevant notes by name and one-line description: notes written in this
project, then the most recently used, with a share kept for your global notes.
The list is limited to about 12 KB however much is stored; agents **search**
for the rest and read a note's full text only when it is relevant. The turn's
activity log shows a **Memory** line:

- **On · N saved notes in context** means the list reached the agent.
- **On, but the saved notes could not be loaded for this turn** means the
  lookup failed or timed out. The turn continues without the list.

If no Memory line appears, memory is off for the account running the turn.

## Review and export

**Review notes** lists every note by namespace, with a filter box; expand a
note to read it, move it to another namespace, or delete it. Notes no agent has
read or changed for 30 days are marked **unused**. **Export** downloads all
notes as one Markdown file, with each note under its name.

## Commands

Agents manage notes with the CoCalc CLI, using the turn's runtime agent
identity rather than your account credentials:

~~~bash
cocalc project chat memory list [--namespace <namespace>]
cocalc project chat memory read <name>
cocalc project chat memory search <words...>
cocalc project chat memory write <name> --description "<one line>" --stdin
cocalc project chat memory move <name> <namespace|global>
cocalc project chat memory delete <name>
cocalc project chat memory namespaces
cocalc project chat memory export [--namespace <namespace>] [--output notes.md]
~~~

Agents see and change only global notes and the namespaces of their project.
Only you create namespaces and choose which projects see them. Claude Code also
has equivalent memory tools. Ask an agent to "remember" or "forget" something,
or to show its memory notes.

## Guidance and limits

- One fact per note, with a short kebab-case name and a one-line description.
  Agents update an existing note instead of writing a duplicate, and merge
  related notes.
- Notes must never contain secrets, credentials, or tokens.
- Notes are saved data, not instructions. Agents should verify a note before
  relying on it, and delete notes that turn out to be wrong.
- At most 2,000 notes per account (500 per namespace, global notes counting as
  one) and 8 MB. When memory is nearly full, turns are asked to merge related
  notes and delete outdated ones. The rate of changes is limited per account.
`;
