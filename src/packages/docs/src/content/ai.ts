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

## Answer questions from Codex

When Codex needs your input, an orange badge can mark the conversation in the
chat list. Open that conversation to see its pending requests above the messages.

1. Read the request's status. A blocking question pauses the current turn.
   For an asynchronous question, Codex may continue working while it waits;
   your response is added to the conversation as a user message.
2. Answer every question. Choose a suggested answer, or use the text field
   when one is offered.
3. Choose **Send response** and check the status. **Response submitted** means
   your response is saved and is waiting for Codex to accept it. Follow the
   conversation to see what happens next.

Choose **Decline** to tell Codex you will not answer the question.
**Acknowledge** suppresses a pending email notification, while **Snooze 5 minutes**
delays it when email delivery is enabled. Both leave the question open; a
paused turn still needs a response.

If a disconnected request offers **Continue with this answer**, use it to
submit the saved response again. If the request card is no longer available,
send your answer in the conversation.

In **CoCalc Lite**, requests are available within the project. Cross-device
inbox and email delivery are unavailable.

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
