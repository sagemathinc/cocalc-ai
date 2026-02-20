/**
 * Workspace file operation backend primitives for the CLI.
 *
 * This module centralizes file list/cat/put/get/rm/mkdir/rg/fd operations and
 * the end-to-end workspace file health checks used by both direct CLI commands
 * and daemon-backed file command handlers.
 */
import { dirname } from "node:path";

export type WorkspaceFileCheckResult = {
  step: string;
  status: "ok" | "fail" | "skip";
  duration_ms: number;
  detail: string;
};

export type WorkspaceFileCheckReport = {
  ok: boolean;
  workspace_id: string;
  workspace_title: string;
  temp_path: string;
  kept: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  results: WorkspaceFileCheckResult[];
};

export type WorkspaceFileCheckBenchRun = {
  run: number;
  ok: boolean;
  duration_ms: number;
  passed: number;
  failed: number;
  skipped: number;
  temp_path: string;
  first_failure: string | null;
};

export type WorkspaceFileCheckBenchStepStat = {
  step: string;
  runs: number;
  ok: number;
  fail: number;
  skip: number;
  avg_ms: number;
  min_ms: number;
  max_ms: number;
};

export type WorkspaceFileCheckBenchReport = {
  ok: boolean;
  workspace_id: string;
  workspace_title: string;
  runs: number;
  ok_runs: number;
  failed_runs: number;
  total_duration_ms: number;
  avg_duration_ms: number;
  min_duration_ms: number;
  max_duration_ms: number;
  run_results: WorkspaceFileCheckBenchRun[];
  step_stats: WorkspaceFileCheckBenchStepStat[];
};

type WorkspaceIdentity = {
  project_id: string;
  title: string;
};

type WorkspaceFilesystem = {
  getListing: (path: string) => Promise<any>;
  readFile: (path: string, encoding?: string) => Promise<any>;
  writeFile: (path: string, data: Buffer) => Promise<void>;
  rm: (
    path: string,
    options: { recursive?: boolean; force?: boolean },
  ) => Promise<void>;
  mkdir: (
    path: string,
    options?: { recursive?: boolean },
  ) => Promise<void>;
  ripgrep: (
    path: string,
    pattern: string,
    options: { options?: string[]; timeout: number; maxSize: number },
  ) => Promise<any>;
  fd: (
    path: string,
    options: {
      pattern?: string;
      options?: string[];
      timeout: number;
      maxSize: number;
    },
  ) => Promise<any>;
};

export type WorkspaceFileOpsDeps<Ctx> = {
  resolveWorkspaceFilesystem: (
    ctx: Ctx,
    workspaceIdentifier?: string,
    cwd?: string,
  ) => Promise<{ workspace: WorkspaceIdentity; fs: WorkspaceFilesystem }>;
  resolveWorkspaceFromArgOrContext: (
    ctx: Ctx,
    workspaceIdentifier?: string,
    cwd?: string,
  ) => Promise<WorkspaceIdentity>;
  asUtf8: (value: unknown) => string;
  normalizeProcessExitCode: (
    raw: unknown,
    stdout: string,
    stderr: string,
  ) => number;
  normalizeBoolean: (value: unknown) => boolean;
};

function normalizeWorkspacePathPrefix(value: string | undefined): string {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return ".cocalc-cli-check";
  const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed || ".cocalc-cli-check";
}

function joinWorkspacePath(...parts: string[]): string {
  const normalized = parts
    .map((x) => `${x}`.trim())
    .filter(Boolean)
    .map((x) => x.replace(/^\/+/, "").replace(/\/+$/, ""))
    .filter(Boolean);
  return normalized.join("/");
}

function assertWorkspaceCheck(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

export function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  if (value == null || `${value}`.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export function createWorkspaceFileOps<Ctx>(deps: WorkspaceFileOpsDeps<Ctx>) {
  const {
    resolveWorkspaceFilesystem,
    resolveWorkspaceFromArgOrContext,
    asUtf8,
    normalizeProcessExitCode,
    normalizeBoolean,
  } = deps;

  async function workspaceFileListData({
    ctx,
    workspaceIdentifier,
    path,
    cwd,
  }: {
    ctx: Ctx;
    workspaceIdentifier?: string;
    path?: string;
    cwd?: string;
  }): Promise<Array<Record<string, unknown>>> {
    const { workspace, fs } = await resolveWorkspaceFilesystem(
      ctx,
      workspaceIdentifier,
      cwd,
    );
    const targetPath = path?.trim() || ".";
    const listing = await fs.getListing(targetPath);
    const files = listing?.files ?? {};
    const names = Object.keys(files).sort((a, b) => a.localeCompare(b));
    return names.map((name) => {
      const info: any = files[name] ?? {};
      return {
        workspace_id: workspace.project_id,
        path: targetPath,
        name,
        is_dir: !!info.isDir,
        size: info.size ?? null,
        mtime: info.mtime ?? null,
      };
    });
  }

  async function workspaceFileCatData({
    ctx,
    workspaceIdentifier,
    path,
    cwd,
  }: {
    ctx: Ctx;
    workspaceIdentifier?: string;
    path: string;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    const { workspace, fs } = await resolveWorkspaceFilesystem(
      ctx,
      workspaceIdentifier,
      cwd,
    );
    const content = String(await fs.readFile(path, "utf8"));
    return {
      workspace_id: workspace.project_id,
      path,
      content,
      bytes: Buffer.byteLength(content),
    };
  }

  async function workspaceFilePutData({
    ctx,
    workspaceIdentifier,
    dest,
    data,
    parents,
    cwd,
  }: {
    ctx: Ctx;
    workspaceIdentifier?: string;
    dest: string;
    data: Buffer;
    parents: boolean;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    const { workspace, fs } = await resolveWorkspaceFilesystem(
      ctx,
      workspaceIdentifier,
      cwd,
    );
    if (parents) {
      await fs.mkdir(dirname(dest), { recursive: true });
    }
    await fs.writeFile(dest, data);
    return {
      workspace_id: workspace.project_id,
      dest,
      bytes: data.length,
      status: "uploaded",
    };
  }

  async function workspaceFileGetData({
    ctx,
    workspaceIdentifier,
    src,
    cwd,
  }: {
    ctx: Ctx;
    workspaceIdentifier?: string;
    src: string;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    const { workspace, fs } = await resolveWorkspaceFilesystem(
      ctx,
      workspaceIdentifier,
      cwd,
    );
    const data = await fs.readFile(src);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    return {
      workspace_id: workspace.project_id,
      src,
      bytes: buffer.length,
      content_base64: buffer.toString("base64"),
      status: "downloaded",
    };
  }

  async function workspaceFileRmData({
    ctx,
    workspaceIdentifier,
    path,
    recursive,
    force,
    cwd,
  }: {
    ctx: Ctx;
    workspaceIdentifier?: string;
    path: string;
    recursive: boolean;
    force: boolean;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    const { workspace, fs } = await resolveWorkspaceFilesystem(
      ctx,
      workspaceIdentifier,
      cwd,
    );
    await fs.rm(path, {
      recursive,
      force,
    });
    return {
      workspace_id: workspace.project_id,
      path,
      recursive,
      force,
      status: "removed",
    };
  }

  async function workspaceFileMkdirData({
    ctx,
    workspaceIdentifier,
    path,
    parents,
    cwd,
  }: {
    ctx: Ctx;
    workspaceIdentifier?: string;
    path: string;
    parents: boolean;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    const { workspace, fs } = await resolveWorkspaceFilesystem(
      ctx,
      workspaceIdentifier,
      cwd,
    );
    await fs.mkdir(path, { recursive: parents });
    return {
      workspace_id: workspace.project_id,
      path,
      parents,
      status: "created",
    };
  }

  async function workspaceFileRgData({
    ctx,
    workspaceIdentifier,
    pattern,
    path,
    timeoutMs,
    maxBytes,
    options,
    cwd,
  }: {
    ctx: Ctx;
    workspaceIdentifier?: string;
    pattern: string;
    path?: string;
    timeoutMs: number;
    maxBytes: number;
    options?: string[];
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    const { workspace, fs } = await resolveWorkspaceFilesystem(
      ctx,
      workspaceIdentifier,
      cwd,
    );
    const result = await fs.ripgrep(path?.trim() || ".", pattern, {
      options,
      timeout: timeoutMs,
      maxSize: maxBytes,
    });
    const stdout = asUtf8((result as any)?.stdout);
    const stderr = asUtf8((result as any)?.stderr);
    const exit_code = normalizeProcessExitCode((result as any)?.code, stdout, stderr);
    return {
      workspace_id: workspace.project_id,
      path: path?.trim() || ".",
      pattern,
      stdout,
      stderr,
      exit_code,
      truncated: normalizeBoolean((result as any)?.truncated),
    };
  }

  async function workspaceFileFdData({
    ctx,
    workspaceIdentifier,
    pattern,
    path,
    timeoutMs,
    maxBytes,
    options,
    cwd,
  }: {
    ctx: Ctx;
    workspaceIdentifier?: string;
    pattern?: string;
    path?: string;
    timeoutMs: number;
    maxBytes: number;
    options?: string[];
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    const { workspace, fs } = await resolveWorkspaceFilesystem(
      ctx,
      workspaceIdentifier,
      cwd,
    );
    const result = await fs.fd(path?.trim() || ".", {
      pattern: pattern?.trim() || undefined,
      options,
      timeout: timeoutMs,
      maxSize: maxBytes,
    });
    const stdout = asUtf8((result as any)?.stdout);
    const stderr = asUtf8((result as any)?.stderr);
    const exit_code = normalizeProcessExitCode((result as any)?.code, stdout, stderr);
    return {
      workspace_id: workspace.project_id,
      path: path?.trim() || ".",
      pattern: pattern?.trim() || null,
      stdout,
      stderr,
      exit_code,
      truncated: normalizeBoolean((result as any)?.truncated),
    };
  }

  async function runWorkspaceFileCheck({
    ctx,
    workspaceIdentifier,
    pathPrefix,
    timeoutMs,
    maxBytes,
    keep,
  }: {
    ctx: Ctx;
    workspaceIdentifier?: string;
    pathPrefix?: string;
    timeoutMs: number;
    maxBytes: number;
    keep: boolean;
  }): Promise<WorkspaceFileCheckReport> {
    const workspace = await resolveWorkspaceFromArgOrContext(ctx, workspaceIdentifier);
    const prefix = normalizeWorkspacePathPrefix(pathPrefix);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempPath = joinWorkspacePath(prefix, runId);
    const fileName = "probe.txt";
    const filePath = joinWorkspacePath(tempPath, fileName);
    const marker = `cocalc-cli-check-${runId}`;
    const content = `${marker}\n`;
    const results: WorkspaceFileCheckResult[] = [];

    const record = async <T>(
      step: string,
      fn: () => Promise<T>,
      onSuccess?: (value: T) => string,
    ): Promise<T | undefined> => {
      const started = Date.now();
      try {
        const value = await fn();
        results.push({
          step,
          status: "ok",
          duration_ms: Date.now() - started,
          detail: onSuccess ? onSuccess(value) : "ok",
        });
        return value;
      } catch (err) {
        results.push({
          step,
          status: "fail",
          duration_ms: Date.now() - started,
          detail: err instanceof Error ? err.message : `${err}`,
        });
        return undefined;
      }
    };

    await record(
      "mkdir",
      async () =>
        await workspaceFileMkdirData({
          ctx,
          workspaceIdentifier: workspace.project_id,
          path: tempPath,
          parents: true,
        }),
      () => `created ${tempPath}`,
    );

    await record(
      "put",
      async () =>
        await workspaceFilePutData({
          ctx,
          workspaceIdentifier: workspace.project_id,
          dest: filePath,
          data: Buffer.from(content),
          parents: true,
        }),
      (value: any) => `uploaded ${value?.bytes ?? Buffer.byteLength(content)} bytes`,
    );

    await record(
      "list",
      async () => {
        const rows = await workspaceFileListData({
          ctx,
          workspaceIdentifier: workspace.project_id,
          path: tempPath,
        });
        assertWorkspaceCheck(
          rows.some((row) => `${row.name ?? ""}` === fileName),
          `expected '${fileName}' in directory listing`,
        );
        return rows;
      },
      () => `found ${fileName}`,
    );

    await record(
      "cat",
      async () => {
        const data = await workspaceFileCatData({
          ctx,
          workspaceIdentifier: workspace.project_id,
          path: filePath,
        });
        assertWorkspaceCheck(`${data.content ?? ""}` === content, "cat content mismatch");
        return data;
      },
      () => `read ${filePath}`,
    );

    await record(
      "get",
      async () => {
        const data = await workspaceFileGetData({
          ctx,
          workspaceIdentifier: workspace.project_id,
          src: filePath,
        });
        const decoded = Buffer.from(`${data.content_base64 ?? ""}`, "base64").toString(
          "utf8",
        );
        assertWorkspaceCheck(decoded === content, "get content mismatch");
        return data;
      },
      () => `downloaded ${filePath}`,
    );

    await record(
      "rg",
      async () => {
        const data = await workspaceFileRgData({
          ctx,
          workspaceIdentifier: workspace.project_id,
          pattern: marker,
          path: tempPath,
          timeoutMs,
          maxBytes,
          options: ["-F"],
        });
        assertWorkspaceCheck(
          Number(data.exit_code ?? 1) === 0,
          `rg exit_code=${data.exit_code ?? "unknown"}`,
        );
        assertWorkspaceCheck(
          `${data.stdout ?? ""}`.includes(fileName),
          `rg output missing '${fileName}'`,
        );
        return data;
      },
      () => `matched ${fileName}`,
    );

    await record(
      "fd",
      async () => {
        const data = await workspaceFileFdData({
          ctx,
          workspaceIdentifier: workspace.project_id,
          pattern: fileName,
          path: tempPath,
          timeoutMs,
          maxBytes,
        });
        assertWorkspaceCheck(
          Number(data.exit_code ?? 1) === 0,
          `fd exit_code=${data.exit_code ?? "unknown"}`,
        );
        assertWorkspaceCheck(
          `${data.stdout ?? ""}`.includes(fileName),
          `fd output missing '${fileName}'`,
        );
        return data;
      },
      () => `matched ${fileName}`,
    );

    if (keep) {
      results.push({
        step: "rm",
        status: "skip",
        duration_ms: 0,
        detail: "skipped (--keep)",
      });
    } else {
      await record(
        "rm",
        async () =>
          await workspaceFileRmData({
            ctx,
            workspaceIdentifier: workspace.project_id,
            path: tempPath,
            recursive: true,
            force: true,
          }),
        () => `removed ${tempPath}`,
      );
    }

    if (!keep) {
      // Best-effort cleanup if rm check failed earlier.
      try {
        await workspaceFileRmData({
          ctx,
          workspaceIdentifier: workspace.project_id,
          path: tempPath,
          recursive: true,
          force: true,
        });
      } catch {
        // ignore cleanup errors
      }
    }

    const passed = results.filter((x) => x.status === "ok").length;
    const failed = results.filter((x) => x.status === "fail").length;
    const skipped = results.filter((x) => x.status === "skip").length;
    return {
      ok: failed === 0,
      workspace_id: workspace.project_id,
      workspace_title: workspace.title,
      temp_path: tempPath,
      kept: keep,
      total: results.length,
      passed,
      failed,
      skipped,
      results,
    };
  }

  async function runWorkspaceFileCheckBench({
    ctx,
    workspaceIdentifier,
    pathPrefix,
    timeoutMs,
    maxBytes,
    keep,
    runs,
  }: {
    ctx: Ctx;
    workspaceIdentifier?: string;
    pathPrefix?: string;
    timeoutMs: number;
    maxBytes: number;
    keep: boolean;
    runs: number;
  }): Promise<WorkspaceFileCheckBenchReport> {
    const runResults: WorkspaceFileCheckBenchRun[] = [];
    const stepStats = new Map<
      string,
      {
        runs: number;
        ok: number;
        fail: number;
        skip: number;
        totalMs: number;
        minMs: number;
        maxMs: number;
      }
    >();

    let workspaceId = "";
    let workspaceTitle = "";

    for (let run = 1; run <= runs; run++) {
      const started = Date.now();
      const report = await runWorkspaceFileCheck({
        ctx,
        workspaceIdentifier,
        pathPrefix,
        timeoutMs,
        maxBytes,
        keep,
      });
      const durationMs = Date.now() - started;
      workspaceId = report.workspace_id;
      workspaceTitle = report.workspace_title;

      const firstFailure = report.results.find((x) => x.status === "fail");
      runResults.push({
        run,
        ok: report.ok,
        duration_ms: durationMs,
        passed: report.passed,
        failed: report.failed,
        skipped: report.skipped,
        temp_path: report.temp_path,
        first_failure: firstFailure ? `${firstFailure.step}: ${firstFailure.detail}` : null,
      });

      for (const row of report.results) {
        if (!stepStats.has(row.step)) {
          stepStats.set(row.step, {
            runs: 0,
            ok: 0,
            fail: 0,
            skip: 0,
            totalMs: 0,
            minMs: Number.POSITIVE_INFINITY,
            maxMs: 0,
          });
        }
        const stats = stepStats.get(row.step)!;
        stats.runs += 1;
        if (row.status === "ok") stats.ok += 1;
        if (row.status === "fail") stats.fail += 1;
        if (row.status === "skip") stats.skip += 1;
        stats.totalMs += row.duration_ms;
        stats.minMs = Math.min(stats.minMs, row.duration_ms);
        stats.maxMs = Math.max(stats.maxMs, row.duration_ms);
      }
    }

    const totalDurationMs = runResults.reduce((sum, row) => sum + row.duration_ms, 0);
    const okRuns = runResults.filter((x) => x.ok).length;
    const failedRuns = runResults.length - okRuns;
    const minDurationMs =
      runResults.length > 0 ? Math.min(...runResults.map((x) => x.duration_ms)) : 0;
    const maxDurationMs =
      runResults.length > 0 ? Math.max(...runResults.map((x) => x.duration_ms)) : 0;

    const aggregatedSteps: WorkspaceFileCheckBenchStepStat[] = Array.from(stepStats.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([step, stats]) => ({
        step,
        runs: stats.runs,
        ok: stats.ok,
        fail: stats.fail,
        skip: stats.skip,
        avg_ms: stats.runs ? Math.round(stats.totalMs / stats.runs) : 0,
        min_ms: Number.isFinite(stats.minMs) ? stats.minMs : 0,
        max_ms: stats.maxMs,
      }));

    return {
      ok: failedRuns === 0,
      workspace_id: workspaceId,
      workspace_title: workspaceTitle,
      runs: runResults.length,
      ok_runs: okRuns,
      failed_runs: failedRuns,
      total_duration_ms: totalDurationMs,
      avg_duration_ms: runResults.length ? Math.round(totalDurationMs / runResults.length) : 0,
      min_duration_ms: minDurationMs,
      max_duration_ms: maxDurationMs,
      run_results: runResults,
      step_stats: aggregatedSteps,
    };
  }

  return {
    workspaceFileListData,
    workspaceFileCatData,
    workspaceFilePutData,
    workspaceFileGetData,
    workspaceFileRmData,
    workspaceFileMkdirData,
    workspaceFileRgData,
    workspaceFileFdData,
    runWorkspaceFileCheck,
    runWorkspaceFileCheckBench,
    parsePositiveInteger,
  };
}
