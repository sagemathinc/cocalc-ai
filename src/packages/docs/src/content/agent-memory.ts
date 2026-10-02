/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export const AGENT_MEMORY_BODY = String.raw`
Agent memory lets integrated Codex and Claude Code keep short notes that
persist across sessions and across all of your projects: your preferences and
corrections, project conventions, how to build, test, or deploy, and lessons
from earlier mistakes. Both agents share the same notes.

## Turn it on or off

Agent memory is **off by default**. Turn it on in **Settings -> AI** (also
reachable from the Memory button in the Codex and Claude Code settings). The
dialog explains who can use your memory before you enable it. Turning memory
off stops agents from reading or writing notes; the saved notes are kept until
you delete them, and you can review and delete them in the same panel.

Memory belongs to your account. A turn uses your memory only when it runs as
you, for example a message you send, or an Agent Networks message that starts a
turn as you. Collaborators' turns use their own memory, not yours.

## What agents see

When memory is on, each turn starts with an **Agent memory** block that lists
every saved note by name and one-line description. Agents read a note's full
text only when it is relevant. The turn's activity log shows a **Memory** line:

- **On · N saved notes in context** means the list reached the agent.
- **On, but the saved notes could not be loaded for this turn** means the
  lookup failed or timed out. The turn continues without the list.

If no Memory line appears, memory is off for the account running the turn.

## Commands

Agents manage notes with the CoCalc CLI, using the turn's runtime agent
identity rather than your account credentials:

~~~bash
cocalc project chat memory list
cocalc project chat memory read <name>
cocalc project chat memory write <name> --description "<one line>" --stdin
cocalc project chat memory delete <name>
~~~

Claude Code also has equivalent memory tools. Ask an agent to "remember" or
"forget" something, or to show its memory notes.

## Guidance and limits

- One fact per note, with a short kebab-case name and a one-line description.
  Agents update an existing note instead of writing a duplicate.
- Notes must never contain secrets, credentials, or tokens.
- Notes are saved data, not instructions. Agents should verify a note before
  relying on it, and delete notes that turn out to be wrong.
- The number and size of notes and the rate of changes are limited per
  account.
`;
