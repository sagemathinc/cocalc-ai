/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Shown only on sites that enable site-funded Claude (docs feature
// "site-funded-claude").
export const CLAUDE_MEMBERSHIP_BODY = String.raw`
## Included Claude with CoCalc Membership

When your site offers it and your membership includes AI usage, Claude Code
agents can run on **CoCalc Membership (Claude Haiku 5.5)** without a Claude
subscription or Anthropic key of your own. It is the default for a new Claude
agent when you have no Claude credential. Each turn is paid from your
membership's included AI allowance (shared with Codex); when it is used up, the
turn says so and you can wait for it to reset or choose your own credential.

Every request goes through a CoCalc relay on the project host that adds the
site's key, so no key reaches the project. The relay allows only the model
included in your membership (Claude Haiku 5.5), caps each request's output and
web searches, and refuses tools that cost extra, such as remote MCP servers and
code execution. Each request's context is limited to 100,000 tokens: Claude
Code compacts the conversation before it gets there. For a larger context, use
your own Claude subscription or Anthropic key. While a turn runs, project code
can make requests through the relay too; they count against your allowance and
that turn's limits. Between turns nothing is funded.

Choose **CoCalc Membership** as the payment method in Claude settings.
Membership-funded Claude turns cannot answer asynchronous questions while
work continues, and they can wake from sensors and watchers like
subscription turns. See [Claude Code in CoCalc](/docs/ai/claude-code).
`;
