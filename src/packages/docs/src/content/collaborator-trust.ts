/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export const COLLABORATOR_TRUST_BODY = String.raw`
A project is one shared workspace. Everyone you add as a **collaborator** works
in it as the same Linux user, much like people who share one account on a
server. That is what makes working together in real time possible, and it also
means that nothing in the project can be kept from a collaborator. This page
lists what that includes, so you can decide whom to add.

**Viewers** are different: they can read only the files you allow, and cannot
run code, use terminals or SSH. See
[Add project collaborators](/docs/projects/collaborators).

## What a collaborator can do

A collaborator can:

- read, change and delete every file in the project, including hidden files
  and other people's work;
- see the programs running in the project and, while they run, read their
  command lines, environment and memory;
- use whatever a running terminal, notebook or agent has access to while it
  runs: the files it writes, its environment variables and any temporary
  access material it holds;
- change the files that steer programs for everyone, such as shell startup
  files, \`~/.local/share/cocalc/startup.sh\`, git hooks, and the instruction
  files, settings, hooks and MCP server configuration that agents read (for
  example \`AGENTS.md\` or \`CLAUDE.md\`). Your next command or agent turn in
  the project then follows what they wrote;
- read every secret the project holds:
  [project secrets](/docs/projects/project-secrets), \`.env\` files, API keys,
  SSH private keys (and so reach whatever those keys open), git credentials and
  cloud command-line configuration;
- add SSH keys and set up programs that start with the project.

Anything a collaborator has seen, they can keep. Removing someone ends their
CoCalc access, but it does not undo what they copied or set up: see
[After removing a collaborator](/docs/projects/collaborators#after-removing-a-collaborator)
for the steps to take.

None of this needs a flaw in CoCalc: it is what sharing one workspace means.
Deliberately using another person's access, such as their paid subscription,
can also break a provider's terms of service, but CoCalc cannot stop a
collaborator who sets out to do it.

## What stays out of the project

- Your CoCalc password and your account settings are not stored in the
  project.
- With the site's default Claude subscription runtime, Claude Code paid by
  your own Claude subscription runs outside the project, and your Claude
  subscription credential is never placed in the project. If a site runs it
  in the project instead, see
  [Using your subscription in a shared project](/docs/ai/claude-subscription-in-project#using-your-subscription-in-a-shared-project).

## Simple rules

- Share a project only with people you trust with everything in it.
- Use separate projects when people need different levels of trust, and add
  someone who only needs to read as a **Viewer**.
- Keep long-lived secrets out of shared projects; prefer scoped, short-lived
  tokens.
- In a shared project, any collaborator can change an agent's instructions and
  tools, so check an agent's work there as you would a collaborator's.
`;
