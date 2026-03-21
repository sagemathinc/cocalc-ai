import { Command } from "commander";
import type {
  RootfsImageEntry,
  RootfsImageSection,
  RootfsImageTheme,
  RootfsImageVisibility,
} from "@cocalc/util/rootfs-images";

export type RootfsCommandDeps = {
  withContext: any;
  resolveProjectFromArgOrContext: any;
  waitForLro: any;
  serializeLroSummary: any;
};

function parseLimit(value?: string, fallback = 100): number {
  return Math.max(1, Math.min(10_000, Number(value ?? fallback) || fallback));
}

function parseVisibility(value?: string): RootfsImageVisibility | undefined {
  const trimmed = `${value ?? ""}`.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (
    trimmed === "private" ||
    trimmed === "collaborators" ||
    trimmed === "public"
  ) {
    return trimmed;
  }
  throw new Error(
    `invalid visibility '${value}'; expected private, collaborators, or public`,
  );
}

function parseTags(value?: string): string[] | undefined {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return undefined;
  const tags = Array.from(
    new Set(
      trimmed
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  );
  return tags.length ? tags : undefined;
}

function parseThemeJson(value?: string): RootfsImageTheme | undefined {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`invalid --theme-json: ${err}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--theme-json must be a JSON object");
  }
  return parsed as RootfsImageTheme;
}

function normalizeSection(value?: string): RootfsImageSection | undefined {
  const trimmed = `${value ?? ""}`.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (
    trimmed === "official" ||
    trimmed === "mine" ||
    trimmed === "collaborators" ||
    trimmed === "public"
  ) {
    return trimmed;
  }
  throw new Error(
    `invalid section '${value}'; expected official, mine, collaborators, or public`,
  );
}

function serializeRootfsImageEntry(entry: RootfsImageEntry) {
  return {
    image_id: entry.id,
    label: entry.label,
    image: entry.image,
    section: entry.section ?? null,
    visibility: entry.visibility ?? null,
    official: !!entry.official,
    prepull: !!entry.prepull,
    hidden: !!entry.hidden,
    digest: entry.digest ?? null,
    arch: entry.arch ?? null,
    gpu: !!entry.gpu,
    size_gb: entry.size_gb ?? null,
    owner_id: entry.owner_id ?? null,
    owner_name: entry.owner_name ?? null,
    warning: entry.warning ?? null,
    description: entry.description ?? null,
    tags: entry.tags ?? [],
    can_manage: !!entry.can_manage,
  };
}

export function registerRootfsCommand(
  program: Command,
  deps: RootfsCommandDeps,
): Command {
  const {
    withContext,
    resolveProjectFromArgOrContext,
    waitForLro,
    serializeLroSummary,
  } = deps;
  const rootfs = program
    .command("rootfs")
    .description("managed RootFS catalog and publish operations");

  rootfs
    .command("list")
    .description("list visible RootFS catalog entries")
    .option(
      "--section <section>",
      "filter by section: official, mine, collaborators, public",
    )
    .option("--image <image>", "filter by runtime image name")
    .option("--label <label>", "filter by label substring")
    .option("--limit <n>", "max rows", "100")
    .action(
      async (
        opts: {
          section?: string;
          image?: string;
          label?: string;
          limit?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs list", async (ctx) => {
          const section = normalizeSection(opts.section);
          const imageFilter = `${opts.image ?? ""}`.trim().toLowerCase();
          const labelFilter = `${opts.label ?? ""}`.trim().toLowerCase();
          let images = (await ctx.hub.system.getRootfsCatalog({})).images ?? [];
          if (section) {
            images = images.filter((entry) => entry.section === section);
          }
          if (imageFilter) {
            images = images.filter((entry) =>
              `${entry.image ?? ""}`.trim().toLowerCase().includes(imageFilter),
            );
          }
          if (labelFilter) {
            images = images.filter((entry) =>
              `${entry.label ?? ""}`.trim().toLowerCase().includes(labelFilter),
            );
          }
          return images
            .slice(0, parseLimit(opts.limit))
            .map(serializeRootfsImageEntry);
        });
      },
    );

  rootfs
    .command("save")
    .description("create or update a RootFS catalog entry")
    .requiredOption("--image <image>", "runtime image reference")
    .requiredOption("--label <label>", "catalog label")
    .option("--image-id <id>", "update an existing catalog entry by id")
    .option("--description <text>", "catalog description")
    .option("--visibility <visibility>", "private, collaborators, or public")
    .option("--tags <csv>", "comma-separated tags")
    .option("--theme-json <json>", "theme metadata as a JSON object")
    .option("--official", "mark as official (admin only)")
    .option("--prepull", "mark for automatic prepull on new hosts (admin only)")
    .option("--hidden", "hide from normal catalog views")
    .action(
      async (
        opts: {
          image: string;
          label: string;
          imageId?: string;
          description?: string;
          visibility?: string;
          tags?: string;
          themeJson?: string;
          official?: boolean;
          prepull?: boolean;
          hidden?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs save", async (ctx) => {
          const entry = await ctx.hub.system.saveRootfsCatalogEntry({
            image_id: `${opts.imageId ?? ""}`.trim() || undefined,
            image: opts.image,
            label: opts.label,
            description: opts.description,
            visibility: parseVisibility(opts.visibility),
            tags: parseTags(opts.tags),
            theme: parseThemeJson(opts.themeJson),
            official: opts.official ? true : undefined,
            prepull: opts.prepull ? true : undefined,
            hidden: opts.hidden ? true : undefined,
          });
          return serializeRootfsImageEntry(entry);
        });
      },
    );

  rootfs
    .command("publish")
    .description("publish the current RootFS state of a project")
    .option("-w, --project <project>", "project id or name")
    .requiredOption("--label <label>", "catalog label for the published image")
    .option("--description <text>", "catalog description")
    .option("--visibility <visibility>", "private, collaborators, or public")
    .option("--tags <csv>", "comma-separated tags")
    .option("--theme-json <json>", "theme metadata as a JSON object")
    .option("--official", "mark as official (admin only)")
    .option("--prepull", "mark for automatic prepull on new hosts (admin only)")
    .option("--hidden", "hide from normal catalog views")
    .option("--wait", "wait for the publish LRO to finish")
    .action(
      async (
        opts: {
          project?: string;
          label: string;
          description?: string;
          visibility?: string;
          tags?: string;
          themeJson?: string;
          official?: boolean;
          prepull?: boolean;
          hidden?: boolean;
          wait?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs publish", async (ctx) => {
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          const op = await ctx.hub.system.publishProjectRootfsImage({
            project_id: ws.project_id,
            label: opts.label,
            description: opts.description,
            visibility: parseVisibility(opts.visibility),
            tags: parseTags(opts.tags),
            theme: parseThemeJson(opts.themeJson),
            official: opts.official ? true : undefined,
            prepull: opts.prepull ? true : undefined,
            hidden: opts.hidden ? true : undefined,
          });
          if (!opts.wait) {
            return {
              project_id: ws.project_id,
              op_id: op.op_id,
              scope_type: op.scope_type,
              scope_id: op.scope_id,
              stream_name: op.stream_name,
              status: "queued",
            };
          }
          const waited = await waitForLro(ctx, op.op_id, {
            timeoutMs: ctx.timeoutMs,
            pollMs: ctx.pollMs,
          });
          if (waited.timedOut) {
            throw new Error(
              `rootfs publish timed out (op=${op.op_id}, last_status=${waited.status})`,
            );
          }
          const summary = await ctx.hub.lro.get({ op_id: op.op_id });
          if (!summary) {
            return {
              project_id: ws.project_id,
              op_id: op.op_id,
              status: waited.status,
              error: waited.error ?? null,
            };
          }
          if (summary.status !== "succeeded") {
            throw new Error(
              `rootfs publish failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
            );
          }
          return serializeLroSummary(summary);
        });
      },
    );

  return rootfs;
}
