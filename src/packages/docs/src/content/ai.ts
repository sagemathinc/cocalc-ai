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

## Check usage and recover a failed sign-in

Open account **AI** settings to inspect the connection. **ChatGPT Codex
usage** appears when ChatGPT Plan is the resolved payment source. Click
**Refresh usage** to request a live check. Meters show the percentage remaining
and reset timing for each reported usage window; they are not a per-thread
spending total. Missing or unchecked usage data does not mean the allowance
is zero. The displayed account and plan help identify the connection. Hosted
usage checks and device sign-in need an available project; open one when
prompted and retry.

**Connection not verified** means a stored credential was found but the live
check did not confirm access. **Sign-in needs refresh** means that connection
needs attention before Codex can use it.

1. For an expired-authentication error, choose **Sign in again**, or update
   the OpenAI API key used by the thread.
2. Refresh usage or check the connection status again.
3. Return to the failed message and use **Submit again** when offered.

An allowance error is different from an expired sign-in. Follow its **Open
AI Settings** or usage link and check the thread's selected payment source.
Membership-funded access depends on the deployment and account; connecting
a personal plan does not increase the membership allowance itself.

## Use project secrets for keys

For code that calls OpenAI directly from a notebook, script, or terminal, store
the API key as a project secret such as \`OPENAI_API_KEY\`. Do not paste keys
into notebooks, chat messages, shell history, or committed files.

## Why this matters in CoCalc

AI access is both account-level and project-contextual. The account connection
lets Codex work in the UI; project secrets let ordinary code and terminal-native
agents use credentials without turning private tokens into shared content.
`;
