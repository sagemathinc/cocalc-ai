/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export const COCALC_ACCESS_BODY = String.raw`
## Let an agent work across your CoCalc projects

An agent already works inside its own project. CoCalc access lets you give it
additional access to your account and other projects, so you can ask questions
across a course, compare research projects, or ask it to carry out work elsewhere.
You do not need to create or copy an API key for the agent.

This connector works with native Codex agents and with the Claude Code
experimental preview. Custom ACP harnesses cannot use it; their Agent Networks
remain available. Claude's provider-side connectors are a separate feature.
Switching an agent's runtime does not delete its saved CoCalc access settings.

For example, an instructor could ask: "Read the notebooks in my student projects
and summarize which exercises students have completed. Do not change anything."
A researcher could ask: "Compare the results in these three projects and write
a report in your own project."

## Configure access

Open a named agent and choose **+ > CoCalc** in the message composer. Once
configured, the small CoCalc connector icon beside **+** reopens these settings;
it is muted when access is disabled. Settings apply to the agent across
conversations, not just the current conversation.

1. Turn on **Enable CoCalc access**.
2. Choose the account privileges the task needs.
3. Select individual projects, or choose **All projects**.
4. Choose read-only files or full runtime access.
5. Click **Save access** and complete any sign-in confirmation.

Start a new turn after saving. These settings belong to your account and this
agent; another collaborator does not automatically receive your permissions.

To keep the settings for later, turn off **Enable CoCalc access** and save.
To delete the saved settings altogether, choose **Remove connector** and confirm.
Removal also revokes active temporary credentials and hides the connector icon.
You can configure it again through **+ > CoCalc**.

## What the choices mean

- **Read basic account information** allows the supported basic account lookup.
- **List my projects** lets the agent discover projects by name and read their
  basic listing information. This does not itself allow reading their files.
- **Create projects** permits the supported project-creation operation.
- **Read-only files** allows reading permitted files without changing them or
  running commands in that project. Choose **Whole project**, or restrict access
  to named directories. Hidden and protected paths remain excluded.
- **Full runtime** allows reading and changing files and running code. Use it
  when you want the agent to edit, execute notebooks, or perform computations.
  It does not automatically grant every account or project-management action.

The agent's own project is omitted from the project picker because the agent
already has full access there. Turning off CoCalc access does not remove that
existing access.

## All projects

**All projects** applies to projects where you are a full collaborator, including
projects you create or join later. It does not grant access to someone else's
private projects or turn your viewer access into full collaborator access.
Choose read-only files for questions about students' progress or results across
many projects. Choose full runtime only when the agent needs to make changes.

Individual project settings override the all-projects default. For example,
you can choose read-only access for all projects and full runtime for one
project. Directory restrictions on an individual project still apply.
Enable **List my projects** as well when the agent should discover projects by
name. Having file access and being able to list projects are separate choices.

## Ask the agent to use the access

Give the project name and a concrete task, such as:

> Use the CoCalc CLI to list the files in remote-jupyter-student-validation.
> Read its assignment notebook and summarize progress without changing files.

For a course, ask for a bounded first pass, such as one assignment across five
student projects, before requesting a larger analysis. The agent can inspect
current saved files; a question about unsaved notebook work or a running session
may require full runtime access and the corresponding live notebook tools.

## Lifetime and shared projects

CoCalc supplies temporary access while the agent is working and ends it when
the turn finishes, fails, or is cancelled. Turning access off or saving changed
permissions also invalidates active temporary access. Existing connections can
take up to the documented 25-second authorization window to close under normal
operation; the user interface is not a process-stop button.

Processes and collaborators in the agent's own project may be able to copy and
use its temporary credential, including from elsewhere, while it remains valid.
Its permissions cover all selected projects. Give access only in a source
project whose collaborators you trust with those permissions.

Ending access does not undo changes, erase data already copied, or stop programs
the agent launched. Full runtime access can also expose other credentials stored
in a target project. Choose read-only access when the task only needs inspection.

## If a request is denied

Reopen CoCalc access and check that the settings were saved for the correct
agent. To find a project by name, enable project listing; to read files, also
grant file access to that project. Confirm that you are still a full collaborator
and that the requested file is within the allowed directories.

After changing settings, send a new turn. If access still fails, include the
failed command and error in your report, but never paste a credential or its
file contents. A site upgrade needs matching hub, project-host, and project CLI
versions; a freshly built website alone does not update an older running project.
`;
