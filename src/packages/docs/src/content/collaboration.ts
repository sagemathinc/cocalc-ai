/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const COLLABORATORS_BODY = String.raw`
## Choose the access needed

Use project access to bring a coauthor or reviewer into the same workspace.
Choose the role before inviting them:

| Access | Use it when | What it allows |
| --- | --- | --- |
| Collaborator | A coauthor needs to edit or rerun the work. | Normal read/write access, project runtimes, terminals, SSH, and project tools. |
| Viewer | A reviewer needs to read saved files and results. | Read-only access to allowed files, without editing, code execution, terminals, SSH, or project management. |
| Published file share | You want an unlisted link to selected material. | Signed-in viewers can read and copy the shared content. See [Publish project files](/docs/projects/publish-files). |

For an end-to-end example, see [Start and hand off a research task](/docs/projects/research-handoff).

## Invite a collaborator or viewer

1. Open the project and go to **Settings -> People**.
2. Find and select an existing account, or enter the recipient's email address.
3. Under **Access level**, choose **Collaborator** or **Viewer**. The form
   starts with collaborator access; select viewer access explicitly for a
   read-only review.
4. For a viewer, set **Viewer file access** as described below.
5. For an email invitation, select **Require acceptance using the invited email
   address** when the recipient must accept with that exact verified address.
6. Use **Invite selected user** or **Send Invitation**, as appropriate. Review
   the delivery result; if CoCalc provides a link for manual delivery, copy it
   and send it to the intended recipient.
7. After acceptance, check the person's role in the project member list. For a
   viewer, also check the file-access summary beside their name.

For courses, add students through the course interface instead of manually
sharing every project.

## Select the files a viewer can read

**Viewer file access** offers **Full project, excluding sensitive paths** and
**Selected files and directories only**. The full-project option excludes
\`.snapshots\`, \`.ssh\`, and \`.local/share/cocalc\`; selecting particular
files keeps the review focused on the material you intend to share.

For selected access, replace the example entries with one project-relative
file, directory, or glob per line. For example:

~~~text
README.md
review/
~~~

A trailing slash includes the directory's contents. The default exclusions
remain in effect. Include any figures or supporting files needed to read the
report, and check that the selected paths exist. The invitation form requires
at least one include rule for selected access; it does not check whether the
paths exist or whether exclusions prevent access to every selected path.

Ask the reviewer to open the intended report or notebook and confirm that its
saved results are readable. A viewer cannot rerun a notebook; choose
collaborator access when that is part of the review.

## Change access when the work changes

In **Settings -> People**, use **Make viewer** beside a collaborator to choose
a read policy and confirm the change. Use **Make collaborator** beside a viewer
only when they need normal write and runtime access, then confirm the change.
Check the resulting role in the member list.

Use **Remove** and confirm when an existing member no longer needs project
access. For an invitation that has not been accepted, open **Pending
Invitations** and use **Revoke**. These controls depend on your permission to
manage collaborators; the project owner can help when they are unavailable.

Keep the paths to the report, saved results, and next steps in the
[research handoff](/docs/projects/research-handoff). For coauthors editing
together, use [chat](/docs/collaboration/chat) beside the relevant files to
record questions and decisions.
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

On phones, open **Chat tools** and choose the green check,
**Resolve this discussion**, when offered. Confirm with **Resolve**.

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
