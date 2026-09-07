/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const CODEX_CHAT_BODY = String.raw`
## What Codex chat is for

Codex chat is the integrated agent interface in CoCalc-ai. A project chat thread
can include humans and Codex, and Codex can use project-aware tools to inspect
files, run commands, work with notebooks, and make changes.

## Understand Codex access

New chats created through the hosted CoCalc UI use full project access:
Codex can read and modify files, run commands, install software, and use the
network inside the project environment. Explicitly read-only sessions can
still be created through other supported interfaces. A working directory
selects where commands start; it is not a permission boundary.

1. Open the project whose files and software Codex should work with.
2. Click **Codex** in the chat controls to open **Codex settings**.
3. Read the **Access** notice and include the files, intended changes, and
   constraints in your request.

CoCalc Lite offers an **Access** choice instead: **Read only**, **Workspace
write**, or **Full access**. These configure the Codex command sandbox. Read
only still permits network access. Workspace write permits workspace and
temporary-directory writes; Full access removes that command-sandbox file
restriction. Select the mode appropriate for the task and click **Save**.

## Open Codex

1. Open the project.
2. Open the Agents or chat area.
3. Start a Codex thread.
4. Ask a concrete task, including relevant files and constraints.

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

For terminal-native agents such as Claude Code or opencode, install and run them
inside a normal project terminal. CoCalc provides the durable Linux environment;
those tools provide their own agent interface.

## Choose model, reasoning, and speed

Click **Codex** in a thread's chat controls to open **Codex settings**. These
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

## Guide a running turn or queue a follow-up

While Codex is working, the composer offers **Steer** and **Queue**.

Use **Steer** to send guidance to the running turn. For example, if Codex is
editing a notebook and you notice the wrong dataset, write "Use the August
data in data/august.csv" and click **Steer**. CoCalc requests steering of the
active turn. If the turn ends at that boundary, the request can become queued
instead; check its displayed status to see how it was accepted.

Use **Queue** for a separate follow-up that should run after the current
turn, such as "After this finishes, summarize the changed cells." Type the
message and click **Queue**. It appears with a queued label while it waits.

Steering supplies an instruction; it does not undo changes already made.
Inspect the response and project state to confirm how Codex applied the
guidance. When no Codex turn is running, the composer uses **Send** for a
normal message instead.

## Give better tasks

Name files, describe the desired outcome, and ask Codex to validate changes.
For live notebooks, ask Codex to use the live notebook APIs. For UI actions,
docs action ids such as \`settings.environment.secrets\` let agents open the
right panel directly.

## Manage a queued or unsent message

A queued Codex message has controls alongside its status.

1. Choose **Edit** to revise the request, then save the edit before the next
   turn starts. The saved version will be used for that turn; the UI can show
   **edited version sent** to identify it.
2. Choose **Steer** if the waiting text should instead guide the currently
   running turn.
3. Choose **Cancel** to cancel that queued request.

Check the message status after acting. Once execution has started, changing
the displayed message is not the same operation as updating a waiting
request.

A **not sent** message can be a cancelled request or a failed submission.
When **Submit again** is offered, inspect the text before using it. If an error
is reported, resolve it first, such as reconnecting an expired ChatGPT sign-in
or updating the selected API key. Read the
reported error instead of assuming that every failed request is an allowance
problem. Retrying is an explicit submission, so verify the message text
before sending it again.

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

1. In the thread, click **Codex** to open **Codex settings**.
2. Choose a payment source and click **Save**. **ChatGPT Plan**, **Project
   OpenAI API key**, and **Account OpenAI API key** appear when configured.
   **CoCalc Membership** is available only when the site and account provide
   an included allowance.
3. Check the payment label in the chat controls before submitting work.

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
