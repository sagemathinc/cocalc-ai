/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export const CLAUDE_SUBSCRIPTION_IN_PROJECT_BODY = String.raw`
When you pay for Claude Code with your own Claude Pro or Max subscription, a
site can run the agent in one of two places. This page explains the one where
Claude Code runs **inside your project**: how your subscription is kept out of
the project, what the agent does get, when that works, and what it means to
share the project with collaborators.

Which place is used is a site setting, **Claude Subscription Runtime**. Its
default is **controller**, where Claude Code runs in a separate, isolated
container and reaches your project through CoCalc's tools. With **project**,
Claude Code runs in your project's own container as the project user, like
Codex: its processes show in the project, and the project's MCP servers and
skills work as configured there.

## Your subscription stays outside the project

Your Claude subscription credential never enters the project. Instead:

1. When CoCalc starts Claude Code in your project, it creates a **relay
   token**: a random 256-bit stand-in, made new for that start.
2. Claude Code gets only the relay token, and the address of a relay on the
   project's host machine, as its credentials.
3. Each model request goes to the relay. The relay checks it, replaces the
   relay token with your real subscription credential, and forwards the
   request to Anthropic. Before a request, the relay checks again that your
   subscription is still connected whenever its last check is more than a
   minute old, so within about a minute of disconnecting it, requests stop
   working.

Before starting Claude Code, CoCalc also clears the ANTHROPIC_API_KEY and
ANTHROPIC_AUTH_TOKEN variables from its environment, and turns off Claude
Code's non-essential network traffic.

## What the relay accepts

The relay passes on only what Claude Code needs to run models:

- only POST requests to the two model endpoints, **/v1/messages** and
  **/v1/messages/count_tokens**, always to Anthropic and never to any other
  host;
- the request path is checked exactly as it was sent, before it is
  interpreted, and any encoded or backslash path separator or dot is refused;
- only the relay's own credential is sent to Anthropic: the caller's
  Authorization, X-Api-Key and Proxy-Authorization headers are dropped.

Anything else is refused. If Claude Code ever needs another endpoint, that
request fails visibly rather than going through.

## When the relay token works

- **During a turn** (from the moment your turn starts until it ends), however
  long the turn takes.
- **Between turns**, until the token has gone 15 minutes without a request
  (with no request still running). After that it is refused until your next
  turn starts.
- **Never after the agent ends.** When the agent process ends, its relay
  token is deleted. A process that still has a copy gets nothing with it.

The agent itself is ended after it has been idle, by default 10 minutes after
your last turn (a site can change this; it can also turn it off). Your next
turn starts a new agent with a **new relay token**, and Claude Code continues
the same conversation. The token is also deleted if the agent process crashes,
and if the project's host is restarted. Within one running agent, all turns
use the same relay token.

## Sharing a project with collaborators

Everyone who can run code in a project can see what runs in it as the project
user. So while your agent is working, and for a short time afterwards, another
process in the project could deliberately obtain the relay token from your
agent's environment or memory, and use it to send requests billed to your
subscription, until the token stops working as described above.

This doesn't happen by accident: it takes intentional circumvention, which
violates Anthropic's terms of service. CoCalc cannot protect you from a
collaborator who sets out to do this. Use your subscription only in projects
where you trust every collaborator.

Before any turn paid by your own subscription in a project that has other
collaborators, CoCalc shows this warning and sends nothing until you accept
it. It asks again whenever the collaborators change, and every time if it
cannot read them. A banner stays in the agent panel while it applies.

## What is not covered here

- **Codex** subscriptions work differently and are not described here.
- Not yet confirmed in a live session: that stopping a project always ends
  its agent at once, and that Claude Code needs only the two endpoints above.
- The relay does not check which project a request comes from, so a relay
  token copied out of your project also works from another project on the
  same host, for as long as it works at all.

See also [Claude Code in CoCalc](/docs/ai/claude-code).
`;
