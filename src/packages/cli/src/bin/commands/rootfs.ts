import { Command } from "commander";
import type {
  RootfsAdminCatalogEntry,
  RootfsDeleteRequestResult,
  RootfsImageEntry,
  RootfsImageEvent,
  RootfsImageSection,
  RootfsImageTheme,
  RootfsImageVisibility,
  RootfsReleaseGcRunResult,
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
    blocked: !!entry.blocked,
    blocked_reason: entry.blocked_reason ?? null,
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
    scan: entry.scan ?? null,
  };
}

function serializeRootfsAdminEntry(entry: RootfsAdminCatalogEntry) {
  return {
    ...serializeRootfsImageEntry(entry),
    deleted: !!entry.deleted,
    deleted_reason: entry.deleted_reason ?? null,
    hidden_at: entry.hidden_at ?? null,
    hidden_by: entry.hidden_by ?? null,
    blocked_at: entry.blocked_at ?? null,
    blocked_by: entry.blocked_by ?? null,
    deleted_at: entry.deleted_at ?? null,
    deleted_by: entry.deleted_by ?? null,
    release_id: entry.release_id ?? null,
    release_gc_status: entry.release_gc_status ?? null,
    delete_blockers: entry.delete_blockers ?? null,
    scan_status: entry.scan_status ?? null,
    scan_tool: entry.scan_tool ?? null,
    scanned_at: entry.scanned_at ?? null,
    events: entry.events ?? [],
  };
}

function formatRootfsEventHuman(event: RootfsImageEvent): string {
  const who = event.actor_name ?? event.actor_account_id ?? "-";
  const details =
    event.reason ??
    event.payload?.blocked_reason ??
    (event.payload?.blockers?.total != null
      ? `blockers=${event.payload.blockers.total}`
      : "");
  return `${event.created} ${event.event_type} by ${who}${details ? ` (${details})` : ""}`;
}

function wrapField({
  label,
  value,
  indent = "   ",
  width = 96,
}: {
  label: string;
  value?: unknown;
  indent?: string;
  width?: number;
}): string[] {
  const text = `${value ?? ""}`.trim();
  if (!text) return [];
  const prefix = `${indent}${label}: `;
  const maxWidth = Math.max(prefix.length + 10, width);
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let current = prefix;
  for (const word of words) {
    const candidate =
      current === prefix ? `${prefix}${word}` : `${current} ${word}`;
    if (candidate.length <= maxWidth || current === prefix) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = `${" ".repeat(prefix.length)}${word}`;
  }
  lines.push(current);
  return lines;
}

function formatRootfsEntriesHuman(
  entries: Array<ReturnType<typeof serializeRootfsImageEntry>>,
): string {
  if (!entries.length) {
    return "(no rootfs images)";
  }
  return entries
    .map((entry, index) => {
      const header = `${index + 1}. ${entry.label}`;
      const lines = [
        header,
        `   id: ${entry.image_id}`,
        `   image: ${entry.image}`,
        `   section: ${entry.section ?? "-"}`,
        `   visibility: ${entry.visibility ?? "-"}`,
        `   owner: ${entry.owner_name ?? entry.owner_id ?? "-"}`,
        `   flags: official=${entry.official} prepull=${entry.prepull} hidden=${entry.hidden} blocked=${entry.blocked} gpu=${entry.gpu} can_manage=${entry.can_manage}`,
      ];
      if (entry.arch != null) {
        const arch = Array.isArray(entry.arch)
          ? entry.arch.join(", ")
          : `${entry.arch}`;
        lines.push(`   arch: ${arch}`);
      }
      if (entry.digest) {
        lines.push(`   digest: ${entry.digest}`);
      }
      if (entry.size_gb != null) {
        lines.push(`   size_gb: ${entry.size_gb}`);
      }
      if (entry.warning && entry.warning !== "none") {
        lines.push(`   warning: ${entry.warning}`);
      }
      if (entry.scan?.status && entry.scan.status !== "unknown") {
        lines.push(
          `   scan: status=${entry.scan.status} tool=${entry.scan.tool ?? "-"} scanned_at=${entry.scan.scanned_at ?? "-"}`,
        );
      }
      lines.push(
        ...wrapField({
          label: "description",
          value: entry.description,
        }),
      );
      lines.push(
        ...wrapField({
          label: "tags",
          value: Array.isArray(entry.tags) ? entry.tags.join(", ") : "",
        }),
      );
      return lines.join("\n");
    })
    .join("\n\n");
}

function formatRootfsAdminEntriesHuman(
  entries: Array<ReturnType<typeof serializeRootfsAdminEntry>>,
): string {
  if (!entries.length) {
    return "(no rootfs images)";
  }
  return entries
    .map((entry, index) => {
      const header = `${index + 1}. ${entry.label}`;
      const lines = [
        header,
        `   id: ${entry.image_id}`,
        `   image: ${entry.image}`,
        `   owner: ${entry.owner_name ?? entry.owner_id ?? "-"}`,
        `   visibility: ${entry.visibility ?? "-"}`,
        `   release_id: ${entry.release_id ?? "-"}`,
        `   lifecycle: hidden=${entry.hidden} blocked=${entry.blocked} deleted=${entry.deleted} release_gc_status=${entry.release_gc_status ?? "-"}`,
      ];
      if (entry.blocked && entry.blocked_reason) {
        lines.push(`   blocked_reason: ${entry.blocked_reason}`);
      }
      if (entry.blocked_at || entry.blocked_by) {
        lines.push(
          `   last_blocked: ${entry.blocked_at ?? "-"} by ${entry.blocked_by ?? "-"}`,
        );
      }
      if (entry.hidden_at || entry.hidden_by) {
        lines.push(
          `   last_hidden: ${entry.hidden_at ?? "-"} by ${entry.hidden_by ?? "-"}`,
        );
      }
      if (entry.deleted_at || entry.deleted_by) {
        lines.push(
          `   deleted_at: ${entry.deleted_at ?? "-"} by ${entry.deleted_by ?? "-"}`,
        );
      }
      if (entry.delete_blockers) {
        lines.push(
          `   delete_blockers: total=${entry.delete_blockers.total} projects=${entry.delete_blockers.projects_using_release} catalog=${entry.delete_blockers.catalog_entries_using_release} prepull=${entry.delete_blockers.prepull_entries_using_release} child_releases=${entry.delete_blockers.child_releases}`,
        );
      }
      if (entry.scan_status || entry.scan_tool || entry.scanned_at) {
        lines.push(
          `   scan: status=${entry.scan_status ?? "unknown"} tool=${entry.scan_tool ?? "-"} scanned_at=${entry.scanned_at ?? "-"}`,
        );
      }
      if (entry.scan?.summary) {
        lines.push(`   scan_summary: ${entry.scan.summary}`);
      }
      if (entry.scan?.report_url) {
        lines.push(`   scan_report: ${entry.scan.report_url}`);
      }
      if (entry.events?.length) {
        lines.push("   recent_events:");
        for (const event of entry.events) {
          lines.push(`     - ${formatRootfsEventHuman(event)}`);
        }
      }
      lines.push(
        ...wrapField({
          label: "description",
          value: entry.description,
        }),
      );
      lines.push(
        ...wrapField({
          label: "tags",
          value: Array.isArray(entry.tags) ? entry.tags.join(", ") : "",
        }),
      );
      return lines.join("\n");
    })
    .join("\n\n");
}

function formatRootfsDeleteResultHuman(
  result: RootfsDeleteRequestResult,
): string {
  const lines = [
    `image_id: ${result.image_id}`,
    `image: ${result.image}`,
    `hidden: ${result.hidden}`,
    `deleted: ${result.deleted}`,
    `delete_requested: ${result.delete_requested}`,
    `release_id: ${result.release_id ?? "-"}`,
    `release_gc_status: ${result.release_gc_status ?? "-"}`,
    `blockers: total=${result.blockers.total} projects=${result.blockers.projects_using_release} catalog=${result.blockers.catalog_entries_using_release} prepull=${result.blockers.prepull_entries_using_release} child_releases=${result.blockers.child_releases}`,
  ];
  return lines.join("\n");
}

function formatRootfsGcResultHuman(result: RootfsReleaseGcRunResult): string {
  const lines = [
    `scanned: ${result.scanned}`,
    `deleted: ${result.deleted}`,
    `blocked: ${result.blocked}`,
    `failed: ${result.failed}`,
  ];
  for (const item of result.items) {
    lines.push(
      "",
      `${item.release_id} ${item.status} ${item.image || item.content_key}`,
    );
    if (item.deleted_replicas != null) {
      lines.push(`  deleted_replicas: ${item.deleted_replicas}`);
    }
    if (item.blockers) {
      lines.push(
        `  blockers: total=${item.blockers.total} projects=${item.blockers.projects_using_release} catalog=${item.blockers.catalog_entries_using_release} prepull=${item.blockers.prepull_entries_using_release} child_releases=${item.blockers.child_releases}`,
      );
    }
    if (item.error) {
      lines.push(`  error: ${item.error}`);
    }
  }
  return lines.join("\n");
}

async function loadAdminRootfsEntryById(ctx: any, image_id: string) {
  const trimmed = `${image_id ?? ""}`.trim();
  if (!trimmed) {
    throw new Error("image_id must be specified");
  }
  const rows: RootfsAdminCatalogEntry[] =
    (await ctx.hub.system.getRootfsCatalogAdmin({})) ?? [];
  const entry = rows.find((row) => row.id === trimmed);
  if (!entry) {
    throw new Error(`rootfs image '${trimmed}' not found`);
  }
  return entry;
}

async function saveAdminRootfsEntry(
  ctx: any,
  entry: RootfsAdminCatalogEntry,
  patch: Partial<RootfsAdminCatalogEntry>,
) {
  return await ctx.hub.system.saveRootfsCatalogEntry({
    image_id: entry.id,
    image: entry.image,
    label: entry.label,
    description: entry.description,
    visibility: entry.visibility,
    arch: entry.arch,
    gpu: entry.gpu,
    size_gb: entry.size_gb,
    tags: entry.tags,
    theme: entry.theme,
    official: patch.official ?? entry.official,
    prepull: patch.prepull ?? entry.prepull,
    hidden: patch.hidden ?? entry.hidden,
    blocked: patch.blocked ?? entry.blocked,
    blocked_reason:
      patch.blocked === false
        ? undefined
        : (patch.blocked_reason ??
          entry.blocked_reason ??
          (patch.blocked ? "Blocked by admin" : undefined)),
  });
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
          const rows = images
            .slice(0, parseLimit(opts.limit))
            .map(serializeRootfsImageEntry);
          if (ctx.globals.json || ctx.globals.output === "json") {
            return rows;
          }
          return formatRootfsEntriesHuman(rows);
        });
      },
    );

  rootfs
    .command("admin-list")
    .description("list all RootFS catalog entries with admin lifecycle details")
    .option("--image <image>", "filter by runtime image name")
    .option("--label <label>", "filter by label substring")
    .option("--include-deleted", "include deleted rows in output")
    .option("--limit <n>", "max rows", "100")
    .action(
      async (
        opts: {
          image?: string;
          label?: string;
          includeDeleted?: boolean;
          limit?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs admin-list", async (ctx) => {
          const imageFilter = `${opts.image ?? ""}`.trim().toLowerCase();
          const labelFilter = `${opts.label ?? ""}`.trim().toLowerCase();
          let rows: RootfsAdminCatalogEntry[] =
            (await ctx.hub.system.getRootfsCatalogAdmin({})) ?? [];
          if (!opts.includeDeleted) {
            rows = rows.filter((entry) => !entry.deleted);
          }
          if (imageFilter) {
            rows = rows.filter((entry) =>
              `${entry.image ?? ""}`.trim().toLowerCase().includes(imageFilter),
            );
          }
          if (labelFilter) {
            rows = rows.filter((entry) =>
              `${entry.label ?? ""}`.trim().toLowerCase().includes(labelFilter),
            );
          }
          const serialized = rows
            .slice(0, parseLimit(opts.limit))
            .map(serializeRootfsAdminEntry);
          if (ctx.globals.json || ctx.globals.output === "json") {
            return serialized;
          }
          return formatRootfsAdminEntriesHuman(serialized);
        });
      },
    );

  rootfs
    .command("delete")
    .description("soft-delete a RootFS catalog entry and request safe GC")
    .requiredOption("--image-id <id>", "catalog image id")
    .option(
      "--reason <text>",
      "optional reason recorded with the delete request",
    )
    .action(
      async (
        opts: {
          imageId: string;
          reason?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs delete", async (ctx) => {
          const result = await ctx.hub.system.requestRootfsImageDeletion({
            image_id: `${opts.imageId ?? ""}`.trim(),
            reason: opts.reason,
          });
          if (ctx.globals.json || ctx.globals.output === "json") {
            return result;
          }
          return formatRootfsDeleteResultHuman(result);
        });
      },
    );

  rootfs
    .command("hide")
    .description("hide a RootFS catalog entry from normal views")
    .requiredOption("--image-id <id>", "catalog image id")
    .action(
      async (
        opts: {
          imageId: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs hide", async (ctx) => {
          const entry = await loadAdminRootfsEntryById(ctx, opts.imageId);
          const result = await saveAdminRootfsEntry(ctx, entry, {
            hidden: true,
          });
          return serializeRootfsImageEntry(result);
        });
      },
    );

  rootfs
    .command("unhide")
    .description("make a hidden RootFS catalog entry visible again")
    .requiredOption("--image-id <id>", "catalog image id")
    .action(
      async (
        opts: {
          imageId: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs unhide", async (ctx) => {
          const entry = await loadAdminRootfsEntryById(ctx, opts.imageId);
          const result = await saveAdminRootfsEntry(ctx, entry, {
            hidden: false,
          });
          return serializeRootfsImageEntry(result);
        });
      },
    );

  rootfs
    .command("block")
    .description("block new use of a RootFS catalog entry")
    .requiredOption("--image-id <id>", "catalog image id")
    .option("--reason <text>", "optional block reason")
    .action(
      async (
        opts: {
          imageId: string;
          reason?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs block", async (ctx) => {
          const entry = await loadAdminRootfsEntryById(ctx, opts.imageId);
          const result = await saveAdminRootfsEntry(ctx, entry, {
            blocked: true,
            blocked_reason: opts.reason,
          });
          return serializeRootfsImageEntry(result);
        });
      },
    );

  rootfs
    .command("unblock")
    .description("remove the block from a RootFS catalog entry")
    .requiredOption("--image-id <id>", "catalog image id")
    .action(
      async (
        opts: {
          imageId: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs unblock", async (ctx) => {
          const entry = await loadAdminRootfsEntryById(ctx, opts.imageId);
          const result = await saveAdminRootfsEntry(ctx, entry, {
            blocked: false,
            blocked_reason: undefined,
          });
          return serializeRootfsImageEntry(result);
        });
      },
    );

  rootfs
    .command("gc")
    .description("garbage collect pending-delete RootFS releases (admin only)")
    .option("--limit <n>", "max pending releases to scan", "10")
    .action(
      async (
        opts: {
          limit?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs gc", async (ctx) => {
          const result = await ctx.hub.system.runRootfsReleaseGc({
            limit: parseLimit(opts.limit, 10),
          });
          if (ctx.globals.json || ctx.globals.output === "json") {
            return result;
          }
          return formatRootfsGcResultHuman(result);
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
