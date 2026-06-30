import { Command } from "commander";

import type {
  BackupProjectToExternalRepositoryResponse,
  FinalizeIncomingProjectBackupMigrationResult,
  PrepareIncomingProjectBackupMigrationResult,
  ProjectSiteMigrationRecord,
} from "@cocalc/conat/hub/api/projects";

export type MigrateCommandDeps = {
  globalsFrom: any;
  contextForGlobals: any;
  closeCommandContext: any;
  emitSuccess: any;
  emitError: any;
  waitForLro: any;
  isValidUUID: (value: string) => boolean;
};

type MigrateOptions = {
  owner?: string;
  title?: string;
  description?: string;
  diskMb?: string;
  sourceUsageBytes?: string;
  restore?: boolean;
  stopSource?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  tag?: string[];
};

type SiteProjectSpec = {
  profile: string;
  project_id: string;
};

const DEFAULT_MIGRATION_TIMEOUT = "12h";
const DEFAULT_DISK_MB: "auto" = "auto";

function normalizeNonEmpty(value: string | undefined, label: string): string {
  const normalized = `${value ?? ""}`.trim();
  if (!normalized) {
    throw new Error(`${label} must be non-empty`);
  }
  return normalized;
}

function parseSiteProjectSpec(
  input: string,
  isValidUUID: (value: string) => boolean,
): SiteProjectSpec {
  const value = normalizeNonEmpty(input, "source");
  const index = value.indexOf(":");
  if (index <= 0 || index === value.length - 1) {
    throw new Error("source must have the form <source-profile>:<project-id>");
  }
  const profile = value.slice(0, index).trim();
  const project_id = value.slice(index + 1).trim();
  if (!profile) {
    throw new Error("source profile must be non-empty");
  }
  if (!isValidUUID(project_id)) {
    throw new Error("source project_id must be a valid UUID");
  }
  return { profile, project_id };
}

function parseDestinationProfile(input: string): string {
  const profile = normalizeNonEmpty(input, "destination profile");
  if (profile.includes(":")) {
    throw new Error("destination must be a profile name, not profile:project");
  }
  return profile;
}

function parseDestinationMigrationSpec(
  input: string,
  isValidUUID: (value: string) => boolean,
): { profile: string; migration_id: string } {
  const value = normalizeNonEmpty(input, "migration");
  const index = value.indexOf(":");
  if (index <= 0 || index === value.length - 1) {
    throw new Error("migration must have the form <destination-profile>:<id>");
  }
  const profile = value.slice(0, index).trim();
  const migration_id = value.slice(index + 1).trim();
  if (!profile) {
    throw new Error("destination profile must be non-empty");
  }
  if (!isValidUUID(migration_id)) {
    throw new Error("migration_id must be a valid UUID");
  }
  return { profile, migration_id };
}

function parseDiskMb(value: string | undefined): number | "auto" {
  const raw = `${value ?? DEFAULT_DISK_MB}`.trim().toLowerCase();
  if (!raw || raw === "auto") {
    return "auto";
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--disk-mb must be a positive integer or auto");
  }
  return parsed;
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value == null || `${value}`.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function profileGlobals(base: Record<string, any>, profile: string) {
  const next = { ...base };
  delete next.api;
  delete next.accountId;
  delete next.account_id;
  delete next.apiKey;
  delete next.cookie;
  delete next.bearer;
  delete next.hubPassword;
  return {
    ...next,
    profile,
    timeout: next.timeout ?? DEFAULT_MIGRATION_TIMEOUT,
  };
}

function migrationWarning() {
  return [
    "This migrates project HOME files only.",
    "Root filesystem state and .local/share/cocalc/rootfs are excluded.",
    "The destination project will use the destination site's default rootfs.",
    "Site B issues backup-write credentials that site A can use for this migration.",
    "Use this only between sites you administer and trust.",
  ];
}

function writeProgress(globals: Record<string, any>, message: string): void {
  if (globals.json || globals.output === "json" || globals.quiet) {
    return;
  }
  console.error(message);
}

function lroResult(summary: any): Record<string, any> {
  const result = summary?.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return result;
  }
  return {};
}

async function runProjectMigration({
  deps,
  command,
  source,
  destination,
  options,
}: {
  deps: MigrateCommandDeps;
  command: Command;
  source: string;
  destination: string;
  options: MigrateOptions;
}) {
  const globals = deps.globalsFrom(command);
  let sourceCtx: any;
  let destinationCtx: any;
  try {
    const sourceSpec = parseSiteProjectSpec(source, deps.isValidUUID);
    const destinationProfile = parseDestinationProfile(destination);
    const owner = normalizeNonEmpty(options.owner, "--owner");
    const disk_mb = parseDiskMb(options.diskMb);
    const source_usage_bytes = parseOptionalPositiveInteger(
      options.sourceUsageBytes,
      "--source-usage-bytes",
    );
    const tags = (options.tag ?? [])
      .map((tag) => `${tag ?? ""}`.trim())
      .filter(Boolean);
    const plan = {
      source_profile: sourceSpec.profile,
      source_project_id: sourceSpec.project_id,
      destination_profile: destinationProfile,
      owner,
      title: options.title ?? null,
      description: options.description ?? null,
      disk_mb,
      source_usage_bytes: source_usage_bytes ?? null,
      restore: !!options.restore,
      stop_source: options.stopSource !== false,
      warnings: migrationWarning(),
    };
    if (options.dryRun) {
      deps.emitSuccess({ globals }, "migrate project", {
        dry_run: true,
        ...plan,
      });
      return;
    }
    if (!options.yes) {
      throw new Error(
        "refusing to migrate without --yes; this exposes destination backup-write credentials to the source site",
      );
    }

    writeProgress(globals, "Connecting to destination site...");
    destinationCtx = await deps.contextForGlobals(
      profileGlobals(globals, destinationProfile),
    );
    writeProgress(globals, "Preparing destination project and backup repo...");
    const prepare =
      (await destinationCtx.hub.projects.prepareIncomingProjectBackupMigration({
        source_site: sourceSpec.profile,
        source_project_id: sourceSpec.project_id,
        owner,
        title: options.title,
        description: options.description,
        disk_mb,
        source_usage_bytes,
        restore_after_finalize: !!options.restore,
      })) as PrepareIncomingProjectBackupMigrationResult;

    writeProgress(globals, "Connecting to source site...");
    sourceCtx = await deps.contextForGlobals(
      profileGlobals(globals, sourceSpec.profile),
    );
    writeProgress(globals, "Queueing source backup into destination repo...");
    const backupOp =
      (await sourceCtx.hub.projects.backupProjectToExternalRepository({
        project_id: sourceSpec.project_id,
        destination_site: destinationProfile,
        destination_project_id: prepare.destination_project_id,
        migration_id: prepare.migration_id,
        rustic_repo_toml: prepare.rustic_repo_toml,
        backup_index_store: prepare.backup_index_store ?? null,
        exclude_rootfs_state: true,
        stop_source: options.stopSource !== false,
        tags,
      })) as BackupProjectToExternalRepositoryResponse;

    writeProgress(
      globals,
      `Waiting for source backup operation ${backupOp.op_id}...`,
    );
    const backupStatus = await deps.waitForLro(sourceCtx, backupOp.op_id, {
      timeoutMs: sourceCtx.timeoutMs,
      pollMs: sourceCtx.pollMs,
      onUpdate: (update: any) => {
        const phase = update?.progress_summary?.phase;
        const message = update?.progress_summary?.message;
        if (phase || message) {
          writeProgress(
            globals,
            `source backup ${update.status}${phase ? ` ${phase}` : ""}${message ? `: ${message}` : ""}`,
          );
        }
      },
    });
    if (backupStatus.timedOut) {
      throw new Error(
        `source backup timed out (op=${backupOp.op_id}, last_status=${backupStatus.status})`,
      );
    }
    if (backupStatus.status !== "succeeded") {
      throw new Error(
        `source backup failed: status=${backupStatus.status} error=${backupStatus.error ?? "unknown"}`,
      );
    }
    const sourceLro = await sourceCtx.hub.lro.get({ op_id: backupOp.op_id });
    const sourceBackupResult = lroResult(sourceLro);
    const snapshotId = `${sourceBackupResult.id ?? ""}`.trim();
    if (!snapshotId) {
      throw new Error(
        `source backup operation ${backupOp.op_id} succeeded without result.id`,
      );
    }

    writeProgress(globals, "Finalizing destination migration record...");
    const finalized =
      (await destinationCtx.hub.projects.finalizeIncomingProjectBackupMigration(
        {
          migration_id: prepare.migration_id,
          destination_project_id: prepare.destination_project_id,
          snapshot_id: snapshotId,
          backup_index_key:
            typeof sourceBackupResult.backup_index_key === "string"
              ? sourceBackupResult.backup_index_key
              : null,
          source_backup_result: sourceBackupResult,
          restore: !!options.restore,
        },
      )) as FinalizeIncomingProjectBackupMigrationResult;
    const status =
      (await destinationCtx.hub.projects.getProjectSiteMigrationStatus({
        migration_id: prepare.migration_id,
      })) as ProjectSiteMigrationRecord;

    deps.emitSuccess(
      {
        globals,
        apiBaseUrl: destinationCtx.apiBaseUrl,
        accountId: destinationCtx.accountId,
      },
      "migrate project",
      {
        source_profile: sourceSpec.profile,
        source_project_id: sourceSpec.project_id,
        destination_profile: destinationProfile,
        destination_project_id: prepare.destination_project_id,
        migration_id: prepare.migration_id,
        source_backup_op_id: backupOp.op_id,
        snapshot_id: snapshotId,
        status: finalized.status,
        destination_status: status.status,
        backup_index_key: status.backup_index_key,
        warnings: [...(prepare.warnings ?? []), ...(finalized.warnings ?? [])],
      },
    );
  } catch (error) {
    deps.emitError({ globals }, "migrate project", error);
    process.exitCode = 1;
  } finally {
    deps.closeCommandContext(sourceCtx);
    deps.closeCommandContext(destinationCtx);
  }
}

async function runMigrationStatus({
  deps,
  command,
  destinationMigration,
}: {
  deps: MigrateCommandDeps;
  command: Command;
  destinationMigration: string;
}) {
  const globals = deps.globalsFrom(command);
  let ctx: any;
  try {
    const spec = parseDestinationMigrationSpec(
      destinationMigration,
      deps.isValidUUID,
    );
    ctx = await deps.contextForGlobals(profileGlobals(globals, spec.profile));
    const status = await ctx.hub.projects.getProjectSiteMigrationStatus({
      migration_id: spec.migration_id,
    });
    deps.emitSuccess(
      { globals, apiBaseUrl: ctx.apiBaseUrl, accountId: ctx.accountId },
      "migrate status",
      status,
    );
  } catch (error) {
    deps.emitError({ globals }, "migrate status", error);
    process.exitCode = 1;
  } finally {
    deps.closeCommandContext(ctx);
  }
}

function addProjectMigrationOptions(command: Command): Command {
  return command
    .option("--owner <email-or-account-id>", "destination owner")
    .option("--title <title>", "destination project title")
    .option("--description <text>", "destination project description")
    .option(
      "--disk-mb <n|auto>",
      "destination disk quota override in MB, or auto",
      DEFAULT_DISK_MB,
    )
    .option(
      "--source-usage-bytes <bytes>",
      "source project HOME usage in bytes, used by --disk-mb auto",
    )
    .option(
      "--restore",
      "request restore after finalize if backend supports it",
    )
    .option("--no-stop-source", "snapshot without stopping the source project")
    .option(
      "--tag <tag>",
      "extra rustic backup tag",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("--dry-run", "show the migration plan without contacting sites")
    .option("--yes", "confirm trusted cross-site backup credential handoff");
}

export function registerMigrateCommand(
  program: Command,
  deps: MigrateCommandDeps,
): Command {
  const migrate = addProjectMigrationOptions(
    program
      .command("migrate")
      .description("admin project migration between CoCalc-AI sites")
      .argument(
        "[args...]",
        "A:<project_id> B, project A:<project_id> B, or status B:<migration_id>",
      ),
  );

  migrate.action(async (args: string[], opts: MigrateOptions, command) => {
    const normalizedArgs = (args ?? []).map((arg) => `${arg ?? ""}`.trim());
    if (normalizedArgs[0] === "status") {
      if (normalizedArgs.length !== 2) {
        const globals = deps.globalsFrom(command);
        deps.emitError(
          { globals },
          "migrate status",
          new Error(
            "usage: cocalc migrate status <destination-profile>:<migration-id>",
          ),
        );
        process.exitCode = 1;
        return;
      }
      await runMigrationStatus({
        deps,
        command,
        destinationMigration: normalizedArgs[1],
      });
      return;
    }

    const projectArgs =
      normalizedArgs[0] === "project"
        ? normalizedArgs.slice(1)
        : normalizedArgs;
    if (projectArgs.length !== 2) {
      const globals = deps.globalsFrom(command);
      deps.emitError(
        { globals },
        "migrate project",
        new Error(
          "usage: cocalc migrate <source-profile>:<project-id> <destination-profile> --owner <email-or-account-id> --yes",
        ),
      );
      process.exitCode = 1;
      return;
    }
    await runProjectMigration({
      deps,
      command,
      source: projectArgs[0],
      destination: projectArgs[1],
      options: opts,
    });
  });

  return migrate;
}

export const testOnly = {
  parseDiskMb,
  parseSiteProjectSpec,
  profileGlobals,
};
