/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const CODEX_CHAT_BODY = String.raw`
## What Codex chat is for

Codex chat is the integrated agent interface in CoCalc-ai. A project chat thread
can include humans and Codex, and Codex can use project-aware tools to inspect
files, run commands, work with notebooks, and make changes.

## Open Codex

1. Open the project.
2. Open the Agents or chat area.
3. Start a Codex thread.
4. Ask a concrete task, including relevant files and constraints.

For terminal-native agents such as Claude Code or opencode, install and run them
inside a normal project terminal. CoCalc provides the durable Linux environment;
those tools provide their own agent interface.

## Give better tasks

Name files, describe the desired outcome, and ask Codex to validate changes.
For live notebooks, ask Codex to use the live notebook APIs. For UI actions,
docs action ids such as \`settings.environment.secrets\` let agents open the
right panel directly.

## Control and acknowledge scheduled runs

Open the automation details in its chat thread to see the schedule, latest
result, and available controls.

- **Run now** starts a manual run without moving the next scheduled run.
  If a run is already active, it does not queue another one.
- **Skip next** skips only the next scheduled occurrence.
- **Pause** and **Resume** control whether scheduled work continues. Pausing
  the schedule does not cancel a run already in progress.
- **Edit** opens the configuration. Deleting the automation removes the
  schedule from the chat thread.

Overlapping runs are not queued. Check **Last run**, the status, and any
displayed error when investigating a missing or unsuccessful result.

Finished automated runs increase the **unacknowledged** count, including
successful, failed, or interrupted runs and **Run now** executions. At **Pause after unacknowledged runs**, the automation
pauses until you review it. Click the unacknowledged-count button to clear
the count; sending a new request to Codex in that thread also clears it.
Acknowledging does not itself mean resuming: use **Resume** when you want
a paused schedule to continue, and confirm the next-run display afterward.

## Why this matters in CoCalc

CoCalc is both a collaborative workspace and an agent sandbox. Humans can review
what Codex changes, keep terminals and notebooks running, use TimeTravel, and
share the same project state with collaborators.
`;

export const AI_CREDENTIALS_BODY = String.raw`
## What AI credentials are for

CoCalc-ai uses OpenAI access for integrated Codex chat. A user can connect a
ChatGPT subscription or configure an OpenAI API key, depending on what access
the deployment and account support.

## Connect access for Codex

1. Open Codex or the AI settings area.
2. Choose **Sign in with ChatGPT** or configure an OpenAI API key.
3. Complete the device authorization or key setup flow.
4. Return to the Codex thread and start a concrete task.

If device authorization is running, keep the authorization panel visible until
the browser confirms that the account is connected.

## Use project secrets for keys

For code that calls OpenAI directly from a notebook, script, or terminal, store
the API key as a project secret such as \`OPENAI_API_KEY\`. Do not paste keys
into notebooks, chat messages, shell history, or committed files.

## Why this matters in CoCalc

AI access is both account-level and project-contextual. The account connection
lets Codex work in the UI; project secrets let ordinary code and terminal-native
agents use credentials without turning private tokens into shared content.
`;
