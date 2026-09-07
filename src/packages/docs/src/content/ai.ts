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

## Run a Bash command on a schedule

For a repeatable script that does not need a new agent decision each time,
use a command automation. Availability and active-automation limits depend
on the project and membership tier. Commands run unattended and can modify
project data; begin with a read-only or idempotent command you have reviewed.

1. Open a Codex chat's **Automation settings…**, enable the schedule, enter a
   **Title**, and select **Bash command** under **Run type**.
2. Enter the **Command**, for example \`pwd\` for a harmless first run.
3. Set **Working directory** explicitly for commands using relative paths.
   Otherwise it is derived from the chat file path, which may be a generated
   chat directory; if no parent is available, it falls back to \`/\` in the
   project runtime.
4. Set **Timeout (seconds)** and **Max output to capture (KB)** to fit the
   command, then configure the schedule and click **Save**.

The run report records the command and working directory, an exit code or
signal when available, and captured stdout and stderr. A truncation notice
means output exceeded the capture limit; it does not mean the command's
entire output was retained in chat. A command with no captured output is
reported as such.

Use **Run now** to try the configured command before relying on scheduled
runs, and inspect its result. That manual run leaves the next scheduled
occurrence in place, so account for both when the command changes data.

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
