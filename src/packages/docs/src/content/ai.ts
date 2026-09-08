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

On phones, open **Chat tools** using the ellipsis button, then choose
**Thread actions** to open the thread menu.

## Find the right guide

- [Connect access and choose funding](/docs/ai/connect-credentials).
- [Configure models, access, and defaults](/docs/ai/codex-settings).

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

## Choose the payment source for a thread

Connecting credentials makes them available. On hosted CoCalc, each thread
can choose how its future turns are funded.

1. Open **Codex settings** using the **Codex** control. On phones, tap the
   button showing the model and reasoning level in the chat header.
2. Choose a payment source and click **Save**. **ChatGPT Plan**, **Project
   OpenAI API key**, and **Account OpenAI API key** appear when configured.
   **CoCalc Membership** is available only when the site and account provide
   an included allowance.
3. Check **Payment source** in **Codex settings** before submitting work.

**Automatic** prefers your ChatGPT plan, then the project API key, account API
key, and membership allowance. You can continue an established session using
ChatGPT or a personal API key without losing its context. Switching an
established personal session to membership funding is disabled: start a new
chat for the membership's constrained model profile. Returning from an
explicit source to Automatic is also disabled after a session starts.

In Lite, configure a ChatGPT plan or an OpenAI API key in account AI settings;
if both are configured, Lite uses the ChatGPT plan.

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

For unavailable-model messages, see
[Configure Codex chats](/docs/ai/codex-settings).

## Use project secrets for keys

For code that calls OpenAI directly from a notebook, script, or terminal, store
the API key as a project secret such as \`OPENAI_API_KEY\`. Do not paste keys
into notebooks, chat messages, shell history, or committed files.

## Complete a Codex authorization request

On sites that enable this workflow, a sensitive CoCalc CLI action can show
**Codex needs fresh account authorization** in the chat, with the status
**Waiting for authorization**.

1. Keep the originating CoCalc browser tab open and choose **Approve in
   CoCalc** on the card.
2. In the authorization page, check the account shown. Follow any instruction
   to sign in with that account.
3. Use an available verification method and choose **Approve CLI Elevation**.
   Complete password or second-factor verification on that page.
4. Return to the chat and inspect the result. The waiting integrated CLI
   command retries automatically after approval, so check its state before
   requesting another attempt.

**Acknowledge** and **Snooze 5 minutes** manage the notification; they do not
authorize the action. An ordinary chat reply or question response also does
not complete this verification. Keep passwords and verification codes out
of chat.

If the request is canceled or expired, inspect the command's reported state
before asking Codex to try again. This card is conditional on site support;
it is not available for every command or deployment.

## Why this matters in CoCalc

AI access is both account-level and project-contextual. The account connection
lets Codex work in the UI; project secrets let ordinary code and terminal-native
agents use credentials without turning private tokens into shared content.
`;

export const CODEX_SETTINGS_BODY = String.raw`
Start with [Open Codex chat](/docs/ai/codex-chat) if you have not used the agent before.

## Understand Codex access

New chats created through the hosted CoCalc UI use full project access:
Codex can read and modify files, run commands, install software, and use the
network inside the project environment. Explicitly read-only sessions can
still be created through other supported interfaces. A working directory
selects where commands start; it is not a permission boundary.

1. Open the project whose files and software Codex should work with.
2. Open **Codex settings** using the **Codex** control. On phones, tap the
   button showing the model and reasoning level in the chat header.
3. Read the **Access** notice and include the files, intended changes, and
   constraints in your request.

CoCalc Lite offers an **Access** choice instead: **Read only**, **Workspace
write**, or **Full access**. These configure the Codex command sandbox. Read
only still permits network access. Workspace write permits workspace and
temporary-directory writes; Full access removes that command-sandbox file
restriction. Select the mode appropriate for the task and click **Save**.

## Choose model, reasoning, and speed

Open **Codex settings** using the **Codex** control. On phones, tap the
button showing the model and reasoning level in the chat header. These
settings apply to the selected thread; the compact chat controls show the
same model and reasoning level.

1. Under **Model and session**, select a **Model**.
2. Choose a **Reasoning level** from the options supported by that model.
   Recheck it after changing models, because the available levels and default
   can change.
3. Choose **Standard** or **Fast** under **Speed**, then click **Save**.

Fast is available only for supported models and uses more Codex credits.
Choose it when lower latency is worth the higher usage; Standard is the
default. Changing to a model without Fast support returns speed to Standard.

Membership-funded turns use the model, reasoning, and speed selected by
CoCalc, so those controls are constrained. Connect and select a personal
ChatGPT plan or OpenAI API key when you need other available model settings.
These choices configure future turns rather than rewriting earlier replies.

## Set defaults for new chats

To reuse your preferred model and reasoning level, open account **AI**
settings and find **New Codex chat defaults**.

1. Choose **Model** and **Reasoning**. The reasoning choices depend on the
   selected model.
2. In Lite, also choose the default **Execution mode**. Hosted CoCalc shows
   its full-project-access notice instead.
3. Click **Save defaults**.

The saved defaults are used when you create a new Codex chat. They do not
serve as a bulk edit of existing threads: open a thread's **Codex settings**
to adjust that thread. Use **Reset to built-in defaults** when you want new
chats to start with CoCalc's supplied choices again.

Review the selected thread's settings before starting a task, especially if
you changed its payment source. Membership-funded turns use the settings
selected by CoCalc even when your account defaults request another model.

## Set the parallel subagent preference

Codex can use worker agents alongside the manager handling your request.
The **Parallel subagents** button in **Codex settings** opens the same
preference as **Maximum concurrent subagents** in account **AI** settings.

1. Open either control.
2. Choose **Automatic (currently 3)** or a number from 1 through 16.
3. Allow the setting to take effect when the Codex session is next loaded.

The number describes worker agents in addition to the manager. It is an
account preference used to configure sessions, not a request to immediately
create that many workers, and not a displayed total for every session on
the account.

Higher values can consume your Codex or API allowance much faster. Start
with a value appropriate for the work and inspect session activity if you
are unsure what remains running. Changing the preference does not by itself
stop existing workers; use the session's stop controls when you need to
interrupt ongoing work.

## Refresh the models available to your ChatGPT account

When a thread uses your **ChatGPT Plan**, CoCalc can check which models that
account currently supports.

1. Open **Codex settings** using the **Codex** control. On phones, tap the
   button showing the model and reasoning level in the chat header.
2. Under **Model and session**, click **Refresh models** and wait for the
   check to finish.
3. If **Model unavailable for this ChatGPT account** appears, choose an
   enabled model. CoCalc keeps the previous selection visible instead of
   silently replacing it.
4. Recheck **Reasoning level** and **Speed**, then click **Save** before
   starting the next turn.

Refreshing checks availability; it does not grant access to additional
models. A model list can contain cached or built-in choices when a live
check has not succeeded.

**Refresh models** is specific to ChatGPT-funded threads. API-key and
membership funding do not use this account-model refresh control.

## Related guides

- [Connect AI access](/docs/ai/connect-credentials)
`;
