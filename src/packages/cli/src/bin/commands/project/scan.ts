/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import { isValidUUID } from "@cocalc/util/misc";
import type { ProjectCommandDeps } from "../project";

function human() {
  if (process.env.COCALC_AGENT_IDENTITY_FILE)
    throw Error(
      "Scan requires human account authentication; delegated agent scope is not yet supported",
    );
}
function id(value: string, option: string) {
  if (!isValidUUID(value)) throw Error(`${option} must be a UUID`);
  return value.toLowerCase();
}

export function registerProjectScanCommands(
  project: Command,
  deps: ProjectCommandDeps,
) {
  const scan = project
    .command("scan")
    .description("opt-in People discovery scans; never start project compute");
  scan
    .command("request")
    .description(
      "request bounded discovery; an accepted receipt is not indexing completion",
    )
    .option("-w, --project <project>", "project id or name")
    .option(
      "--request-id <id>",
      "stable UUID; reuse only with the same project and mode",
    )
    .option("--mode <mode>", "check or reconcile", "check")
    .action(async (opts, command: Command) => {
      human();
      if (opts.mode !== "check" && opts.mode !== "reconcile")
        throw Error("--mode must be check or reconcile");
      const request_id = id(opts.requestId ?? randomUUID(), "--request-id");
      await deps.withContext(command, "project scan request", async (ctx) => {
        const { project_id } = await deps.resolveProjectFromArgOrContext(
          ctx,
          opts.project,
        );
        process.stderr.write(
          `Scan request ${request_id}, project ${project_id}, mode ${opts.mode}. If unconfirmed, inspect this request ID before retrying; do not create a new ID.\n`,
        );
        const result = await ctx.hub.collaborators.requestScan({
          account_id: ctx.accountId,
          project_id,
          request_id,
          mode: opts.mode,
        });
        return { project_id, request_id, mode: opts.mode, ...result };
      });
    });
  scan
    .command("inspect")
    .description("look up an exact admission receipt without submitting work")
    .option("-w, --project <project>", "project id or name")
    .requiredOption("--request-id <id>", "request UUID from submission")
    .action(async (opts, command: Command) => {
      human();
      const request_id = id(opts.requestId, "--request-id");
      await deps.withContext(command, "project scan inspect", async (ctx) => {
        const { project_id } = await deps.resolveProjectFromArgOrContext(
          ctx,
          opts.project,
        );
        const result = await ctx.hub.collaborators.inspectScan({
          account_id: ctx.accountId,
          project_id,
          request_id,
        });
        return { project_id, request_id, ...result };
      });
    });
  scan
    .command("status")
    .description(
      "read discovery progress; discovered does not mean catalog or account-view completion",
    )
    .option("-w, --project <project>", "project id or name")
    .requiredOption("--job-id <id>", "job UUID from the admission receipt")
    .action(async (opts, command: Command) => {
      human();
      const job_id = id(opts.jobId, "--job-id");
      await deps.withContext(command, "project scan status", async (ctx) => {
        const { project_id } = await deps.resolveProjectFromArgOrContext(
          ctx,
          opts.project,
        );
        const result = await ctx.hub.collaborators.getScanStatus({
          account_id: ctx.accountId,
          project_id,
          job_id,
        });
        return { project_id, job_id, ...result };
      });
    });
}
