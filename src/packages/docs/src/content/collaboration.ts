/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const COLLABORATORS_BODY = String.raw`
## What collaborators are for

Collaborators are people who can work in the same CoCalc project. They can edit
files together, share terminals and notebooks, use chat, and see the same
project state.

## Add a collaborator

1. Open the project.
2. Open **Settings**.
3. Go to **People**.
4. Invite a user by email or account.
5. Review pending invitations and access rules.

For courses, add students through the course interface instead of manually
sharing every project.

## Work together

Collaboration is realtime across documents, notebooks, terminals, chat, course
management files, and many project workflows. Use side chat when the discussion
is tied to a specific file or activity.

## Why this matters in CoCalc

CoCalc treats collaboration as part of the computational workspace rather than a
separate sharing layer. Students, instructors, researchers, and agents can work
inside the same project while the backend keeps execution and file state
durable.
`;

export const CHAT_BODY = String.raw`
## What chat is for

CoCalc chat keeps project discussion next to the files, notebooks, terminals,
courses, and agent work it is about. Use chat for questions, review notes,
handoffs, lightweight records of decisions, and conversations with humans or
AI assistants.

## Create and use chat

Create a chat file from the project **New** page or open an existing \`.chat\`
file. Chat files are project files, so they can live beside the notebooks,
assignments, scripts, or folders they discuss.

Use chat when discussion should remain part of the project context. Use a
Markdown file when the result should become durable documentation, instructions,
or a polished explanation.

## Discuss a notebook cell

Use a notebook cell's **Chat** controls to keep questions and review notes
attached to that cell.

1. Click **Chat** on the cell to open its side-chat discussion. If there are
   unread messages, this opens the newest discussion with unread messages.
   Otherwise, it opens the latest active discussion or creates one when needed.
2. Open the arrow beside **Chat** to choose a particular discussion, or choose
   **New Thread** to start another discussion for the same cell.
3. Write your message in the side chat. Use the dropdown to return to the
   discussion you want to continue.

A red badge counts unread messages; a gray badge counts messages when none are
unread. These counts cover the cell's active discussions, excluding archived
and resolved threads.

## Resolve a LaTeX marker discussion

For a LaTeX discussion attached to a source chat marker, the side-chat header
can show a green check. Choose it and confirm **Resolve** to mark the discussion
done and remove its source marker. All discussions attached to that marker are
resolved together.

The messages remain available as read-only history. Open **Archived…** in the
chat sidebar and choose **Open** beside the resolved discussion. Its notice
identifies who resolved it and when; replying and unarchiving are unavailable.

## Mentions

Use @mentions to notify collaborators and create a link back to the relevant
conversation or document context. See [Mentions](/docs/collaboration/mentions)
for the notification workflow.

## Safety

Do not paste passwords, API keys, private tokens, or project secrets into chat.
Use [project secrets](/docs/projects/project-secrets) for credentials that code
needs at runtime.
`;

export const MENTIONS_BODY = String.raw`
## What mentions are for

Mentions notify a collaborator and make the relevant context easy to find
later. Use them when a specific person should look at a chat message, notebook
cell, Markdown note, whiteboard, teaching discussion, or other collaborative
project content.

## Mention a collaborator

Type \`@\` and choose a collaborator when the editor or chat surface supports
mentions. CoCalc sends a notification and lists the mention on the notifications
page so the collaborator can return to the context.

You can mention yourself for testing or to bookmark something you want to find
later.

## Teaching and project workflows

Mentions are useful in courses because instructors and students often need to
refer to a precise file, assignment, or discussion. Keep substantive feedback
in the relevant project context instead of scattering it across external
messages.

## Keep private data out of mentions

Mention text can be visible to collaborators who can access the project or
conversation. Do not include passwords, private tokens, API keys, or other
secrets in mention text.
`;
