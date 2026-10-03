/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { Command } from "commander";
import type { ProjectCommandDeps } from "./project";
import { registerAgentCommands } from "./project/chat-agents";

/** `cocalc agent`: the same commands as `cocalc project chat agent`. */
export function registerAgentCommand(
  program: Command,
  deps: ProjectCommandDeps,
): Command {
  const agent = program
    .command("agent")
    .description(
      "message other agents in your Agent Networks (send, destinations, whoami)",
    );
  registerAgentCommands(
    agent,
    {
      ...deps,
      withContext: (command, name, callback, options) =>
        deps.withContext(
          command,
          name,
          callback,
          options ?? {
            projectOnly: { projectIdentifier: command.opts().project },
          },
        ),
    },
    "agent",
  );
  return agent;
}
