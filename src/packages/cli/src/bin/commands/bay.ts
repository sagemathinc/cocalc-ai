import { Command } from "commander";

export type BayCommandDeps = {
  withContext: any;
};

export function registerBayCommand(
  program: Command,
  deps: BayCommandDeps,
): Command {
  const { withContext } = deps;

  const bay = program.command("bay").description("bay operations");
  const projection = bay
    .command("projection")
    .description("bay-local projection operations");

  bay
    .command("list")
    .description("list visible bays")
    .action(async (command: Command) => {
      await withContext(command, "bay list", async (ctx) => {
        return await ctx.hub.system.listBays({});
      });
    });

  bay
    .command("show <bay_id>")
    .description("show one bay")
    .action(async (bay_id: string, command: Command) => {
      await withContext(command, "bay show", async (ctx) => {
        const bays = await ctx.hub.system.listBays({});
        const match = (bays ?? []).find((x) => x.bay_id === bay_id);
        if (!match) {
          throw new Error(`bay '${bay_id}' not found`);
        }
        return match;
      });
    });

  bay
    .command("load [bay_id]")
    .description("show a live operator load snapshot for one bay")
    .action(async (bay_id: string | undefined, command: Command) => {
      await withContext(command, "bay load", async (ctx) => {
        return await ctx.hub.system.getBayLoad({
          bay_id: bay_id?.trim() || undefined,
        });
      });
    });

  bay
    .command("backup [bay_id]")
    .description("run a one-bay postgres backup now")
    .action(async (bay_id: string | undefined, command: Command) => {
      await withContext(command, "bay backup", async (ctx) => {
        return await ctx.hub.system.runBayBackup({
          bay_id: bay_id?.trim() || undefined,
        });
      });
    });

  bay
    .command("restore [bay_id]")
    .description("stage a fenced restore workspace from a bay backup")
    .option(
      "--backup-set-id <backup_set_id>",
      "restore a specific backup set instead of the latest one",
    )
    .option(
      "--target-dir <path>",
      "restore into this directory instead of the default restores path",
    )
    .option(
      "--target-time <timestamp>",
      "recover to this RFC3339 timestamp instead of replaying all available WAL",
    )
    .option("--write", "materialize the restore instead of a dry run", false)
    .option(
      "--remote-only",
      "ignore the local backup cache and restore only from rustic/R2",
      false,
    )
    .action(
      async (
        bay_id: string | undefined,
        opts: {
          backupSetId?: string;
          targetDir?: string;
          targetTime?: string;
          write?: boolean;
          remoteOnly?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "bay restore", async (ctx) => {
          return await ctx.hub.system.runBayRestore({
            bay_id: bay_id?.trim() || undefined,
            backup_set_id: opts.backupSetId?.trim() || undefined,
            target_dir: opts.targetDir?.trim() || undefined,
            target_time: opts.targetTime?.trim() || undefined,
            dry_run: !opts.write,
            remote_only: opts.remoteOnly === true,
          });
        });
      },
    );

  bay
    .command("restore-test [bay_id]")
    .description(
      "restore the latest bay backup into a fenced workspace and verify it boots",
    )
    .option(
      "--backup-set-id <backup_set_id>",
      "test a specific backup set instead of the latest one",
    )
    .option(
      "--target-dir <path>",
      "use this restore directory instead of the default test path",
    )
    .option("--keep", "keep the restored workspace even after success", false)
    .option(
      "--remote-only",
      "ignore the local backup cache and restore-test only from rustic/R2",
      false,
    )
    .action(
      async (
        bay_id: string | undefined,
        opts: {
          backupSetId?: string;
          targetDir?: string;
          keep?: boolean;
          remoteOnly?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "bay restore-test", async (ctx) => {
          return await ctx.hub.system.runBayRestoreTest({
            bay_id: bay_id?.trim() || undefined,
            backup_set_id: opts.backupSetId?.trim() || undefined,
            target_dir: opts.targetDir?.trim() || undefined,
            keep: opts.keep === true,
            remote_only: opts.remoteOnly === true,
          });
        });
      },
    );

  bay
    .command("backups [bay_id]")
    .description("show current backup and R2 health for one bay")
    .action(async (bay_id: string | undefined, command: Command) => {
      await withContext(command, "bay backups", async (ctx) => {
        return await ctx.hub.system.getBayBackups({
          bay_id: bay_id?.trim() || undefined,
        });
      });
    });

  bay
    .command("backfill")
    .description("backfill persisted bay ownership fields in one-bay mode")
    .option("--bay-id <bay_id>", "override the bay id to write")
    .option("--limit-per-table <n>", "update at most n rows per table")
    .option("--write", "apply changes instead of running a dry run", false)
    .action(
      async (
        opts: {
          bayId?: string;
          limitPerTable?: string;
          write?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "bay backfill", async (ctx) => {
          const limit_per_table =
            opts.limitPerTable == null || `${opts.limitPerTable}`.trim() === ""
              ? undefined
              : Number(opts.limitPerTable);
          if (
            limit_per_table != null &&
            (!Number.isInteger(limit_per_table) || limit_per_table <= 0)
          ) {
            throw new Error("--limit-per-table must be a positive integer");
          }
          return await ctx.hub.system.backfillBayOwnership({
            bay_id: opts.bayId?.trim() || undefined,
            dry_run: !opts.write,
            limit_per_table,
          });
        });
      },
    );

  projection
    .command("status-account-project-index")
    .description(
      "show local account_project_index projector lag and maintenance status",
    )
    .action(async (command: Command) => {
      await withContext(
        command,
        "bay projection status-account-project-index",
        async (ctx) => {
          return await ctx.hub.system.getAccountProjectIndexProjectionStatus(
            {},
          );
        },
      );
    });

  projection
    .command("status-account-collaborator-index")
    .description(
      "show local account_collaborator_index projector lag and maintenance status",
    )
    .action(async (command: Command) => {
      await withContext(
        command,
        "bay projection status-account-collaborator-index",
        async (ctx) => {
          return await ctx.hub.system.getAccountCollaboratorIndexProjectionStatus(
            {},
          );
        },
      );
    });

  projection
    .command("status-account-notification-index")
    .description(
      "show local account_notification_index projector lag and maintenance status",
    )
    .action(async (command: Command) => {
      await withContext(
        command,
        "bay projection status-account-notification-index",
        async (ctx) => {
          return await ctx.hub.system.getAccountNotificationIndexProjectionStatus(
            {},
          );
        },
      );
    });

  projection
    .command("rebuild-account-project-index <account_id>")
    .description(
      "rebuild the account_project_index rows for one home-bay account",
    )
    .option("--write", "apply changes instead of running a dry run", false)
    .action(
      async (
        account_id: string,
        opts: {
          write?: boolean;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "bay projection rebuild-account-project-index",
          async (ctx) => {
            return await ctx.hub.system.rebuildAccountProjectIndex({
              target_account_id: account_id,
              dry_run: !opts.write,
            });
          },
        );
      },
    );

  projection
    .command("rebuild-account-collaborator-index <account_id>")
    .description(
      "rebuild the account_collaborator_index rows for one home-bay account",
    )
    .option("--write", "apply changes instead of running a dry run", false)
    .action(
      async (
        account_id: string,
        opts: {
          write?: boolean;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "bay projection rebuild-account-collaborator-index",
          async (ctx) => {
            return await ctx.hub.system.rebuildAccountCollaboratorIndex({
              target_account_id: account_id,
              dry_run: !opts.write,
            });
          },
        );
      },
    );

  projection
    .command("rebuild-account-notification-index <account_id>")
    .description(
      "rebuild the account_notification_index rows for one home-bay account",
    )
    .option("--write", "apply changes instead of running a dry run", false)
    .action(
      async (
        account_id: string,
        opts: {
          write?: boolean;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "bay projection rebuild-account-notification-index",
          async (ctx) => {
            return await ctx.hub.system.rebuildAccountNotificationIndex({
              target_account_id: account_id,
              dry_run: !opts.write,
            });
          },
        );
      },
    );

  projection
    .command("drain-account-project-index")
    .description(
      "apply unpublished project outbox events to the local account_project_index projection",
    )
    .option("--bay-id <bay_id>", "override the bay id to drain for")
    .option("--limit <n>", "apply at most n unpublished outbox events")
    .option("--write", "apply changes instead of running a dry run", false)
    .action(
      async (
        opts: {
          bayId?: string;
          limit?: string;
          write?: boolean;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "bay projection drain-account-project-index",
          async (ctx) => {
            const limit =
              opts.limit == null || `${opts.limit}`.trim() === ""
                ? undefined
                : Number(opts.limit);
            if (limit != null && (!Number.isInteger(limit) || limit <= 0)) {
              throw new Error("--limit must be a positive integer");
            }
            return await ctx.hub.system.drainAccountProjectIndexProjection({
              bay_id: opts.bayId?.trim() || undefined,
              limit,
              dry_run: !opts.write,
            });
          },
        );
      },
    );

  projection
    .command("drain-account-collaborator-index")
    .description(
      "apply unpublished project outbox events to the local account_collaborator_index projection",
    )
    .option("--bay-id <bay_id>", "override the bay id to drain for")
    .option("--limit <n>", "apply at most n unpublished outbox events")
    .option("--write", "apply changes instead of running a dry run", false)
    .action(
      async (
        opts: {
          bayId?: string;
          limit?: string;
          write?: boolean;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "bay projection drain-account-collaborator-index",
          async (ctx) => {
            const limit =
              opts.limit == null || `${opts.limit}`.trim() === ""
                ? undefined
                : Number(opts.limit);
            if (limit != null && (!Number.isInteger(limit) || limit <= 0)) {
              throw new Error("--limit must be a positive integer");
            }
            return await ctx.hub.system.drainAccountCollaboratorIndexProjection(
              {
                bay_id: opts.bayId?.trim() || undefined,
                limit,
                dry_run: !opts.write,
              },
            );
          },
        );
      },
    );

  projection
    .command("drain-account-notification-index")
    .description(
      "apply unpublished notification outbox events to the local account_notification_index projection",
    )
    .option("--bay-id <bay_id>", "override the bay id to drain for")
    .option("--limit <n>", "apply at most n unpublished outbox events")
    .option("--write", "apply changes instead of running a dry run", false)
    .action(
      async (
        opts: {
          bayId?: string;
          limit?: string;
          write?: boolean;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "bay projection drain-account-notification-index",
          async (ctx) => {
            const limit =
              opts.limit == null || `${opts.limit}`.trim() === ""
                ? undefined
                : Number(opts.limit);
            if (limit != null && (!Number.isInteger(limit) || limit <= 0)) {
              throw new Error("--limit must be a positive integer");
            }
            return await ctx.hub.system.drainAccountNotificationIndexProjection(
              {
                bay_id: opts.bayId?.trim() || undefined,
                limit,
                dry_run: !opts.write,
              },
            );
          },
        );
      },
    );

  return bay;
}
