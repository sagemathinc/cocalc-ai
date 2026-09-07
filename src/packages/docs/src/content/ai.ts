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

## Fork a chat to explore another approach

Use a fork when you want a new conversation that starts from an existing
Codex session's context.

1. Open the source chat's thread menu and choose **Fork chat…**.
2. Enter the **New chat name** and click **Fork**.
3. Continue in the new chat with the alternative task or approach.

CoCalc creates a new chat linked to the original. For a Codex chat with an
existing session, it forks the agent session and carries its context and
configuration into the new one. The visible new chat starts empty: earlier
messages are not copied into it. A link points back to the source discussion.
Without an existing Codex session ID, configuration and linkage can be copied,
but there is no model-session context to fork.

The fork is a conversation/session fork within the same project. It does
not create a separate copy of project files or a Git worktree. Changes made
from either chat therefore concern the shared project environment. Use
separate directories or an explicitly prepared repository checkout when
your experiment requires separate file state, and verify the new thread's
working directory before asking it to edit files.

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

## Set the working directory and keep session context

Open a thread's **Codex settings** and find **Working directory** under
**Model and session**. Enter the directory where Codex should run subsequent
turns and click **Save**.

CoCalc initially fills the working directory from the associated workspace
root when available. A generated CoCalc chat otherwise uses the project home;
an ordinary chat uses the directory containing its chat file. This matters
when a project contains several repositories or related analyses. If you
explicitly clear the directory setting, submission instead falls back to the
chat file's containing directory. Set the directory explicitly when its choice
matters to the task.

A workspace can use its generated chat or an existing chat selected with
**Use current chat tab** in the workspace editor. Its **Agent** button opens
the latest agent thread associated with that workspace chat. If there is no
agent thread yet, open **Chat** and start a Codex turn there first.

**Session ID** is an advanced continuity setting. Keep the existing value
when you only want to change directory. Clearing this field is not a reliable
conversation reset: CoCalc can recover the live session ID from the thread.
Start a new Codex chat when you need fresh conversation context. Workspace
selection does not change project permissions.

## Inspect a generated agent prompt

Some CoCalc workflows prepare an agent prompt alongside your composer
message. When that prompt is present and you have input, the composer
shows **Agent Prompt**.

1. Click **Agent Prompt** to open **Full agent prompt**.
2. Read the prepared text and edit any task details that need correction.
3. Choose **Copy** to copy the draft, **Save** to keep your changes in the
   composer, or **Cancel** to close without applying those edits.
4. Return to the composer and submit the request when ready.

Saving this dialog updates the prepared prompt; it does not submit a new
turn by itself. Use it to review the context supplied for that submission,
especially file paths or task-specific instructions generated by the
workflow. The button is conditional, so an ordinary chat may not show it.
It is an editor for this prepared prompt, not a viewer for every instruction
inside the agent runtime or a way to revise an already-running request.

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

In CoCalc, successful completion uses **Codex turn finished**; an error uses
**Codex turn ended with an error**. Browser notifications use the generic title
**Codex finished**; open CoCalc to inspect the outcome. A completion notice does
not establish that every background command or descendant agent has stopped. Inspect the account's
Codex sessions panel when you need to confirm remaining activity.

## Schedule Codex work in a thread

Open a Codex chat's thread menu and choose **Automation settings…**. The
**Thread automation** dialog lets you configure recurring work in that
thread. Availability and active-automation limits depend on the project and
membership tier; an admission limit can prevent enabling another schedule.

1. Enable **Enable scheduled automation for this thread**, give it a
   **Title**, and choose **Codex prompt** as the **Run type**.
2. Enter what Codex should do on each scheduled run.
3. Under **Schedule**, choose **Daily** or **Every N minutes** and select
   the weekdays under **Repeat on**.
4. For Daily, enter **Run at (24h)**. For an interval, enter **Repeat every
   (minutes)** and either enable **Run all day** or set **From (24h)** and
   **Until (24h)**. Until must be later than From on the same day; this form
   does not accept a window crossing midnight.
5. Check **Timezone**, choose the **Pause after unacknowledged runs** limit,
   and click **Save**.

Use a named timezone such as Europe/Madrid. The form initially uses your
browser's timezone, so verify it before saving a schedule intended for
another location. After saving, inspect the thread's schedule summary and
**Next** run display to confirm the intended timing.

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
