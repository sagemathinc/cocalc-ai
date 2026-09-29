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
      "stable UUID; reuse only with the same project",
    )
    .option(
      "--mode <mode>",
      "legacy option; both request a manual scan",
      "check",
    )
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
          `Scan request ${request_id}, project ${project_id}, mode ${opts.mode}. If unconfirmed, use batch-status or repeat this command with the same request ID; do not create a new ID.\n`,
        );
        const result = await ctx.hub.collaborators.scanProjects({
          account_id: ctx.accountId,
          action: "start",
          project_ids: [project_id],
          request_id,
        });
        return { project_id, request_id, mode: opts.mode, ...result };
      });
    });
  scan
    .command("start")
    .description(
      "start one durable scan of an explicit fixed project selection",
    )
    .option("--all", "select all eligible projects at submission")
    .option("--projects <ids>", "comma-separated project UUIDs")
    .option("--request-id <id>", "stable UUID for submission recovery")
    .action(async (opts, command: Command) => {
      human();
      if (!!opts.all === !!opts.projects)
        throw Error("choose exactly one of --all or --projects");
      const request_id = id(opts.requestId ?? randomUUID(), "--request-id");
      const project_ids = opts.all
        ? ("all" as const)
        : opts.projects
            .split(",")
            .map((value: string) => id(value.trim(), "--projects"));
      await deps.withContext(command, "project scan start", async (ctx) => {
        process.stderr.write(
          `Scan request ${request_id}. Inspect status after an unknown outcome; retain this request ID.\n`,
        );
        return {
          request_id,
          ...(await ctx.hub.collaborators.scanProjects({
            account_id: ctx.accountId,
            action: "start",
            request_id,
            project_ids,
          })),
        };
      });
    });
  for (const action of ["status", "cancel"] as const) {
    scan
      .command(action === "status" ? "batch-status" : "cancel")
      .description(
        action === "status"
          ? "inspect a durable scan, or recover your latest scan"
          : "request cancellation; wait for confirmed stopped children",
      )
      .option("--op-id <id>", "operation UUID (required for cancellation)")
      .option("--after <id>", "result page cursor")
      .action(async (opts, command: Command) => {
        human();
        const op_id = opts.opId ? id(opts.opId, "--op-id") : undefined;
        if (action === "cancel" && !op_id) throw Error("--op-id is required");
        await deps.withContext(command, `project scan ${action}`, async (ctx) =>
          ctx.hub.collaborators.scanProjects(
            action === "cancel"
              ? { account_id: ctx.accountId, action, op_id: op_id! }
              : {
                  account_id: ctx.accountId,
                  action,
                  op_id,
                  after: opts.after ? id(opts.after, "--after") : undefined,
                },
          ),
        );
      });
  }
  scan
    .command("inspect")
    .description(
      "inspect a legacy per-project receipt; use batch-status for new scans",
    )
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
      "read legacy per-project progress; use batch-status for new scans",
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
