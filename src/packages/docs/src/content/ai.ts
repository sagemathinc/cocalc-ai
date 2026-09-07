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

## Set and manage a Codex goal

A goal gives a Codex chat thread an objective to keep working toward across
automatic continuations.

1. In the Codex thread's composer, click **Set goal**.
2. Describe the outcome in **What should Codex accomplish?**
3. Optionally expand **Budget and usage** and enter a positive whole number in
   **Token budget (optional)**. Leave it blank for no goal token budget.
4. Click **Save goal**. If the thread is idle, send a message to start its next
   turn.

Click **Goal: ...** to edit the objective or budget and inspect the reported
tokens used and elapsed minutes. Changes apply during a running turn or when
the next requested turn starts; they can remain **pending** until then.
Opening the goal dialog does not start Codex. A failed change is shown in the
control and its error appears when you reopen the dialog.

Use **Pause** to prevent automatic continuation while allowing the current turn
to finish. **Stop** also interrupts the current turn and requests that its active
goal be paused. Use **Resume** to reactivate an unfinished goal; if the thread is
idle, start another turn for the change to apply. Editing a paused goal's text
or budget alone does not resume it.

Choose **Clear goal** in the dialog to remove the goal. Use **Stop** as well if
you need to interrupt work already running.

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
