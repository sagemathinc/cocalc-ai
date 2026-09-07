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

## Get a notification when a turn finishes

In account settings, find **Notifications** and **Codex and agents**.
**Notify when Codex turns complete by default** sets the preference for threads
that inherit the account default. The channel table separately controls
**Inbox**, **Toast**, **Browser**, and **Email** for **Needs attention**,
**Turn completed**, and **Turn failed**.

To set a thread's completion preference:

1. Open its menu and choose **Behavior...**.
2. In **Edit Thread Behavior**, clear **Mute completion notifications for this thread**
   to request notices, or check it to mute them.
3. Confirm the dialog. Changing this checkbox saves an explicit preference for that thread.

Set the preference before starting work when possible. A turn's completion can
race with a settings change, and changing settings does not withdraw a notice
already produced.

Delivery depends on the enabled channels and site settings. CoCalc can show a
toast while its page is visible or a browser notification while it is hidden.
Browser delivery also needs browser permission; use **Enable browser notifications**
and **Test notification** in account settings. CoCalc suppresses the extra toast
or browser alert when you are directly watching that thread.

Successful completion uses **Codex turn finished**; an error uses
**Codex turn ended with an error**. A completion notice does not establish that
every background command or descendant agent has stopped. Inspect the account's
Codex sessions panel when you need to confirm remaining activity.

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
