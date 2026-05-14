/**
 * Project environment variable and project secret commands.
 */
import { readFile } from "node:fs/promises";
import { Command } from "commander";

import type { ProjectCommandDeps } from "../project";

type ProjectEnv = Record<string, string> | null;

function normalizeEnv(env: ProjectEnv): Record<string, string> {
  if (env == null) return {};
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, `${value}`]),
  );
}

function parseEnvAssignments(assignments: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const assignment of assignments) {
    const idx = assignment.indexOf("=");
    if (idx <= 0) {
      throw new Error(
        `invalid env assignment '${assignment}'; expected KEY=VALUE`,
      );
    }
    const key = assignment.slice(0, idx);
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      throw new Error(`duplicate env assignment '${key}'`);
    }
    env[key] = assignment.slice(idx + 1);
  }
  return env;
}

function parseSecretNames(names?: string[]): string[] | undefined {
  const normalized = (names ?? [])
    .flatMap((value) => value.split(/[\s,]+/))
    .map((value) => value.trim())
    .filter(Boolean);
  if (normalized.length === 0) return undefined;
  return [...new Set(normalized)];
}

async function readSecretValue({
  value,
  file,
  stdin,
  readAllStdin,
}: {
  value?: string;
  file?: string;
  stdin?: boolean;
  readAllStdin: () => Promise<string>;
}): Promise<string> {
  const sources = [value != null, file != null, !!stdin].filter(Boolean).length;
  if (sources !== 1) {
    throw new Error("specify exactly one of --value, --file, or --stdin");
  }
  if (value != null) return value;
  if (file != null) return await readFile(file, "utf8");
  return await readAllStdin();
}

export function registerProjectEnvSecretCommands(
  project: Command,
  deps: ProjectCommandDeps,
): void {
  const {
    withContext,
    resolveProjectFromArgOrContext,
    resolveProject,
    readAllStdin,
  } = deps;

  const env = project
    .command("env")
    .description("manage project environment variables");

  env
    .command("get")
    .description("get project environment variables")
    .option("-w, --project <project>", "project id or name")
    .action(async (opts: { project?: string }, command: Command) => {
      await withContext(command, "project env get", async (ctx) => {
        const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
        return {
          project_id: ws.project_id,
          env: normalizeEnv(
            await ctx.hub.projects.getProjectEnv({
              project_id: ws.project_id,
            }),
          ),
        };
      });
    });

  env
    .command("set <assignments...>")
    .description("set project environment variables from KEY=VALUE assignments")
    .option("-w, --project <project>", "project id or name")
    .option("--replace", "replace the whole environment instead of merging")
    .action(
      async (
        assignments: string[],
        opts: { project?: string; replace?: boolean },
        command: Command,
      ) => {
        await withContext(command, "project env set", async (ctx) => {
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          const patch = parseEnvAssignments(assignments);
          const current = opts.replace
            ? {}
            : normalizeEnv(
                await ctx.hub.projects.getProjectEnv({
                  project_id: ws.project_id,
                }),
              );
          const next = { ...current, ...patch };
          await ctx.hub.projects.setProjectEnv({
            project_id: ws.project_id,
            env: Object.keys(next).length === 0 ? null : next,
          });
          return {
            project_id: ws.project_id,
            env: next,
          };
        });
      },
    );

  env
    .command("unset <names...>")
    .description("remove project environment variables")
    .option("-w, --project <project>", "project id or name")
    .action(
      async (names: string[], opts: { project?: string }, command: Command) => {
        await withContext(command, "project env unset", async (ctx) => {
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          const next = normalizeEnv(
            await ctx.hub.projects.getProjectEnv({
              project_id: ws.project_id,
            }),
          );
          for (const name of names) {
            delete next[name];
          }
          await ctx.hub.projects.setProjectEnv({
            project_id: ws.project_id,
            env: Object.keys(next).length === 0 ? null : next,
          });
          return {
            project_id: ws.project_id,
            env: next,
          };
        });
      },
    );

  env
    .command("clear")
    .description("clear all project environment variables")
    .option("-w, --project <project>", "project id or name")
    .option("-y, --yes", "confirm clearing all variables")
    .action(
      async (opts: { project?: string; yes?: boolean }, command: Command) => {
        await withContext(command, "project env clear", async (ctx) => {
          if (!opts.yes) {
            throw new Error(
              "pass --yes to clear all project environment variables",
            );
          }
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          await ctx.hub.projects.setProjectEnv({
            project_id: ws.project_id,
            env: null,
          });
          return {
            project_id: ws.project_id,
            env: {},
          };
        });
      },
    );

  const secrets = project
    .command("secrets")
    .alias("secret")
    .description("manage encrypted project secrets");

  secrets
    .command("list")
    .description("list project secret metadata")
    .option("-w, --project <project>", "project id or name")
    .action(async (opts: { project?: string }, command: Command) => {
      await withContext(command, "project secrets list", async (ctx) => {
        const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
        return await ctx.hub.projects.listProjectSecrets({
          project_id: ws.project_id,
        });
      });
    });

  secrets
    .command("set <name>")
    .description("set or replace one project secret")
    .option("-w, --project <project>", "project id or name")
    .option("--value <value>", "secret value")
    .option("--file <path>", "read secret value from file")
    .option("--stdin", "read secret value from stdin")
    .action(
      async (
        name: string,
        opts: {
          project?: string;
          value?: string;
          file?: string;
          stdin?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "project secrets set", async (ctx) => {
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          const metadata = await ctx.hub.projects.setProjectSecret({
            project_id: ws.project_id,
            name,
            value: await readSecretValue({
              value: opts.value,
              file: opts.file,
              stdin: opts.stdin,
              readAllStdin,
            }),
          });
          return metadata;
        });
      },
    );

  secrets
    .command("delete <name>")
    .alias("rm")
    .description("delete one project secret")
    .option("-w, --project <project>", "project id or name")
    .action(
      async (name: string, opts: { project?: string }, command: Command) => {
        await withContext(command, "project secrets delete", async (ctx) => {
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          const result = await ctx.hub.projects.deleteProjectSecret({
            project_id: ws.project_id,
            name,
          });
          return {
            project_id: ws.project_id,
            name,
            ...result,
          };
        });
      },
    );

  secrets
    .command("copy")
    .description("copy project secrets from another collaborator project")
    .requiredOption("--from <project>", "source project id or name")
    .option("-w, --project <project>", "target project id or name")
    .option("--name <name...>", "secret name(s) to copy; default copies all")
    .option("--overwrite", "overwrite target secrets with matching names")
    .action(
      async (
        opts: {
          from: string;
          project?: string;
          name?: string[];
          overwrite?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "project secrets copy", async (ctx) => {
          const source = await resolveProject(ctx, opts.from);
          const target = await resolveProjectFromArgOrContext(
            ctx,
            opts.project,
          );
          const result = await ctx.hub.projects.copyProjectSecrets({
            source_project_id: source.project_id,
            target_project_id: target.project_id,
            names: parseSecretNames(opts.name),
            overwrite: !!opts.overwrite,
          });
          return {
            source_project_id: source.project_id,
            target_project_id: target.project_id,
            ...result,
          };
        });
      },
    );
}
