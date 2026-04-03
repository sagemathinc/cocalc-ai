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

  return bay;
}
