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
