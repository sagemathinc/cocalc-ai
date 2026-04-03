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

  return bay;
}
