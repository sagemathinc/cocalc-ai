import { Command } from "commander";

export type LegacyMigrationCommandDeps = {
  withContext: any;
  hubCallByName: any;
  isValidUUID: (value: string) => boolean;
};

export function registerLegacyMigrationCommand(
  program: Command,
  deps: LegacyMigrationCommandDeps,
): Command {
  const { withContext, hubCallByName, isValidUUID } = deps;

  const legacyMigration = program
    .command("legacy-migration")
    .description("legacy cocalc.com migration operations");

  legacyMigration
    .command("retry <legacy_project_id>")
    .description("retry a failed legacy project restore")
    .action(
      async (
        legacy_project_id: string,
        _opts: Record<string, never>,
        command: Command,
      ) => {
        await withContext(
          command,
          "legacy-migration retry",
          async (ctx: any) => {
            if (!isValidUUID(legacy_project_id)) {
              throw new Error(
                `invalid legacy_project_id: ${legacy_project_id}`,
              );
            }
            return await hubCallByName(
              ctx,
              "legacyMigration.retryProjectRestore",
              [{ legacy_project_id }],
              ctx.timeoutMs,
            );
          },
        );
      },
    );

  const remediation = legacyMigration
    .command("remediation")
    .description("final archive remediation operations");

  remediation
    .command("prepare <project_id>")
    .description(
      "admin: create the final cocalc.com archive snapshot and diff metadata for a restored project",
    )
    .option("--snapshot-name <name>", "snapshot name to create")
    .action(
      async (
        project_id: string,
        opts: { snapshotName?: string },
        command: Command,
      ) => {
        await withContext(
          command,
          "legacy-migration remediation prepare",
          async (ctx: any) => {
            if (!isValidUUID(project_id)) {
              throw new Error(`invalid project_id: ${project_id}`);
            }
            return await hubCallByName(
              ctx,
              "legacyMigration.adminPrepareProjectRemediation",
              [
                {
                  project_id,
                  snapshot_name:
                    `${opts.snapshotName ?? ""}`.trim() || undefined,
                },
              ],
              ctx.timeoutMs,
            );
          },
        );
      },
    );

  remediation
    .command("apply <project_id>")
    .description(
      "admin: safely copy a prepared final archive into a restored project",
    )
    .requiredOption("--reason <reason>", "required audit reason")
    .option("--support-reference <reference>", "support ticket or incident")
    .option("--snapshot-name <name>", "prepared snapshot name")
    .action(
      async (
        project_id: string,
        opts: {
          reason: string;
          supportReference?: string;
          snapshotName?: string;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "legacy-migration remediation apply",
          async (ctx: any) => {
            if (!isValidUUID(project_id)) {
              throw new Error(`invalid project_id: ${project_id}`);
            }
            return await hubCallByName(
              ctx,
              "legacyMigration.adminApplyProjectRemediation",
              [
                {
                  project_id,
                  snapshot_name:
                    `${opts.snapshotName ?? ""}`.trim() || undefined,
                  reason: opts.reason.trim(),
                  support_reference:
                    `${opts.supportReference ?? ""}`.trim() || undefined,
                },
              ],
              ctx.timeoutMs,
            );
          },
        );
      },
    );

  const publicShares = legacyMigration
    .command("public-shares")
    .description("legacy public file and directory share operations");

  publicShares
    .command("replay <legacy_project_id>")
    .description(
      "admin: preview or replay retained public_paths records for an explicitly imported project",
    )
    .requiredOption("--reason <reason>", "required audit reason")
    .option("--support-reference <reference>", "support ticket or incident")
    .option("--commit", "apply the replay; otherwise only preview", false)
    .action(
      async (
        legacy_project_id: string,
        opts: {
          reason: string;
          supportReference?: string;
          commit?: boolean;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "legacy-migration public-shares replay",
          async (ctx: any) => {
            if (!isValidUUID(legacy_project_id)) {
              throw new Error(
                `invalid legacy_project_id: ${legacy_project_id}`,
              );
            }
            return await hubCallByName(
              ctx,
              "legacyMigration.adminReplayPublicPaths",
              [
                {
                  legacy_project_id,
                  reason: opts.reason.trim(),
                  support_reference:
                    `${opts.supportReference ?? ""}`.trim() || undefined,
                  commit: opts.commit === true,
                },
              ],
              ctx.timeoutMs,
            );
          },
        );
      },
    );

  publicShares
    .command("replay-restored")
    .description(
      "admin: catch up retained publications for projects restored before automatic replay",
    )
    .requiredOption("--reason <reason>", "required audit reason")
    .option("--support-reference <reference>", "support ticket or incident")
    .option("--batch-size <count>", "projects per bounded RPC", "25")
    .option("--all", "process every candidate batch", false)
    .option("--commit", "apply the replay; otherwise only preview", false)
    .action(
      async (
        opts: {
          reason: string;
          supportReference?: string;
          batchSize: string;
          all?: boolean;
          commit?: boolean;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "legacy-migration public-shares replay-restored",
          async (ctx: any) => {
            const batchSize = Number(opts.batchSize);
            if (
              !Number.isInteger(batchSize) ||
              batchSize < 1 ||
              batchSize > 50
            ) {
              throw new Error("--batch-size must be an integer from 1 to 50");
            }
            let after: string | undefined;
            let batches = 0;
            let hasMore = false;
            const projects: any[] = [];
            do {
              const response = await hubCallByName(
                ctx,
                "legacyMigration.adminReplayRestoredPublicPaths",
                [
                  {
                    after_legacy_project_id: after,
                    limit: batchSize,
                    reason: opts.reason.trim(),
                    support_reference:
                      `${opts.supportReference ?? ""}`.trim() || undefined,
                    commit: opts.commit === true,
                  },
                ],
                ctx.timeoutMs,
              );
              batches += 1;
              projects.push(...response.projects);
              hasMore = response.has_more;
              const next = response.next_after_legacy_project_id;
              if (hasMore && (!next || next === after)) {
                throw new Error("bulk replay cursor did not advance");
              }
              after = next;
            } while (opts.all === true && hasMore);
            return {
              committed: opts.commit === true,
              batches,
              project_count: projects.length,
              imported: projects.reduce(
                (sum, project) => sum + Number(project.imported ?? 0),
                0,
              ),
              skipped: projects.reduce(
                (sum, project) => sum + Number(project.skipped ?? 0),
                0,
              ),
              failed_project_count: projects.filter(
                (project) => !!project.error,
              ).length,
              has_more: hasMore,
              next_after_legacy_project_id: after,
              projects,
            };
          },
        );
      },
    );

  return legacyMigration;
}
