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

## Inspect and stop Codex sessions

Open account **AI** settings and choose **View Codex sessions**. The panel
groups recent turn records by session and shows each session's latest state,
model, payment source, and update time. Use **Open chat**, when available, to
return to its chat file. Some records omit details you cannot access.

The list requests up to 50 recent records; an account stop request handles up
to 100 matching records. These are bounded operations, not an exhaustive
inventory or an instant guarantee that all account activity has ended.

1. Click **Refresh** to update the list.
2. Use a row's **Stop all** control to request interruption of that session,
   or **Stop all active or uncertain** for the account-level stop action.
3. Read the result and refresh again if interruption could not be confirmed.

An **uncertain** state, stale heartbeat, or failed interrupt can mean CoCalc
cannot yet establish whether AI activity has ended. The panel keeps those
records visible as possible ongoing resource use. It can also report active
descendant threads or background commands, with a warning that usage may
continue.

Treat an interruption request as pending until the status confirms its
outcome. A finished manager response alone does not establish that all of
its reported descendant work has ended.

## Why this matters in CoCalc

AI access is both account-level and project-contextual. The account connection
lets Codex work in the UI; project secrets let ordinary code and terminal-native
agents use credentials without turning private tokens into shared content.
`;
