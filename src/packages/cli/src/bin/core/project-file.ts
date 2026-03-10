/**
 * Project file operation backend primitives for the CLI.
 *
 * This module centralizes file list/cat/put/get/rm/mkdir/rg/fd operations and
 * the end-to-end project file health checks used by both direct CLI commands
 * and daemon-backed file command handlers.
 */
import { dirname } from "node:path";

export type ProjectFileCheckResult = {
  step: string;
  status: "ok" | "fail" | "skip";
  duration_ms: number;
  detail: string;
};

export type ProjectFileCheckReport = {
  ok: boolean;
  project_id: string;
  project_title: string;
  temp_path: string;
  kept: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  results: ProjectFileCheckResult[];
};

export type ProjectFileCheckBenchRun = {
  run: number;
  ok: boolean;
  duration_ms: number;
  passed: number;
  failed: number;
  skipped: number;
  temp_path: string;
  first_failure: string | null;
};

export type ProjectFileCheckBenchStepStat = {
  step: string;
  runs: number;
  ok: number;
  fail: number;
  skip: number;
  avg_ms: number;
  min_ms: number;
  max_ms: number;
};

export type ProjectFileCheckBenchReport = {
  ok: boolean;
  project_id: string;
  project_title: string;
  runs: number;
  ok_runs: number;
  failed_runs: number;
  total_duration_ms: number;
  avg_duration_ms: number;
  min_duration_ms: number;
  max_duration_ms: number;
  run_results: ProjectFileCheckBenchRun[];
  step_stats: ProjectFileCheckBenchStepStat[];
};

type ProjectIdentity = {
  project_id: string;
  title: string;
};

type ProjectFilesystem = {
  getListing: (path: string) => Promise<any>;
  readFile: (path: string, encoding?: string) => Promise<any>;
  writeFile: (path: string, data: Buffer) => Promise<void>;
  rm: (
    path: string,
    options: { recursive?: boolean; force?: boolean },
  ) => Promise<void>;
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
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

export type ProjectFileOpsDeps<Ctx> = {
  resolveProjectFilesystem: (
    ctx: Ctx,
    projectIdentifier?: string,
    cwd?: string,
  ) => Promise<{ project: ProjectIdentity; fs: ProjectFilesystem }>;
  resolveProjectFromArgOrContext: (
    ctx: Ctx,
    projectIdentifier?: string,
    cwd?: string,
  ) => Promise<ProjectIdentity>;
  asUtf8: (value: unknown) => string;
  normalizeProcessExitCode: (
    raw: unknown,
    stdout: string,
    stderr: string,
  ) => number;
  normalizeBoolean: (value: unknown) => boolean;
};

function normalizeProjectPathPrefix(value: string | undefined): string {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return ".cocalc-cli-check";
  const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed || ".cocalc-cli-check";
}

function joinProjectPath(...parts: string[]): string {
  const normalized = parts
    .map((x) => `${x}`.trim())
    .filter(Boolean)
    .map((x) => x.replace(/^\/+/, "").replace(/\/+$/, ""))
    .filter(Boolean);
  return normalized.join("/");
}

function assertProjectCheck(condition: unknown, message: string): void {
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

export function createProjectFileOps<Ctx>(deps: ProjectFileOpsDeps<Ctx>) {
  const {
    resolveProjectFilesystem,
    resolveProjectFromArgOrContext,
    asUtf8,
    normalizeProcessExitCode,
    normalizeBoolean,
  } = deps;

  async function projectFileListData({
    ctx,
    projectIdentifier,
    path,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path?: string;
    cwd?: string;
  }): Promise<Array<Record<string, unknown>>> {
    const { project, fs } = await resolveProjectFilesystem(
      ctx,
      projectIdentifier,
      cwd,
    );
    const targetPath = path?.trim() || ".";
    const listing = await fs.getListing(targetPath);
    const files = listing?.files ?? {};
    const names = Object.keys(files).sort((a, b) => a.localeCompare(b));
    return names.map((name) => {
      const info: any = files[name] ?? {};
      return {
        project_id: project.project_id,
        path: targetPath,
        name,
        is_dir: !!info.isDir,
        size: info.size ?? null,
        mtime: info.mtime ?? null,
      };
    });
  }

  async function projectFileCatData({
    ctx,
    projectIdentifier,
    path,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    const { project, fs } = await resolveProjectFilesystem(
      ctx,
      projectIdentifier,
      cwd,
    );
    const content = String(await fs.readFile(path, "utf8"));
    return {
      project_id: project.project_id,
      path,
      content,
      bytes: Buffer.byteLength(content),
    };
  }

  async function projectFilePutData({
    ctx,
    projectIdentifier,
    dest,
    data,
    parents,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    dest: string;
    data: Buffer;
    parents: boolean;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    const { project, fs } = await resolveProjectFilesystem(
      ctx,
      projectIdentifier,
      cwd,
    );
    if (parents) {
      await fs.mkdir(dirname(dest), { recursive: true });
    }
    await fs.writeFile(dest, data);
    return {
      project_id: project.project_id,
      dest,
      bytes: data.length,
      status: "uploaded",
    };
  }

  async function projectFileGetData({
    ctx,
    projectIdentifier,
    src,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    src: string;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    const { project, fs } = await resolveProjectFilesystem(
      ctx,
      projectIdentifier,
      cwd,
    );
    const data = await fs.readFile(src);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    return {
      project_id: project.project_id,
      src,
      bytes: buffer.length,
      content_base64: buffer.toString("base64"),
      status: "downloaded",
    };
  }

  async function projectFileRmData({
    ctx,
    projectIdentifier,
    path,
    recursive,
    force,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    recursive: boolean;
    force: boolean;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    const { project, fs } = await resolveProjectFilesystem(
      ctx,
      projectIdentifier,
      cwd,
    );
    await fs.rm(path, {
      recursive,
      force,
    });
    return {
      project_id: project.project_id,
      path,
      recursive,
      force,
      status: "removed",
    };
  }

  async function projectFileMkdirData({
    ctx,
    projectIdentifier,
    path,
    parents,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    parents: boolean;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    const { project, fs } = await resolveProjectFilesystem(
      ctx,
      projectIdentifier,
      cwd,
    );
    await fs.mkdir(path, { recursive: parents });
    return {
      project_id: project.project_id,
      path,
      parents,
      status: "created",
    };
  }

  async function projectFileRgData({
    ctx,
    projectIdentifier,
    pattern,
    path,
    timeoutMs,
    maxBytes,
    options,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    pattern: string;
    path?: string;
    timeoutMs: number;
    maxBytes: number;
    options?: string[];
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    const { project, fs } = await resolveProjectFilesystem(
      ctx,
      projectIdentifier,
      cwd,
    );
    const result = await fs.ripgrep(path?.trim() || ".", pattern, {
      options,
      timeout: timeoutMs,
      maxSize: maxBytes,
    });
    const stdout = asUtf8((result as any)?.stdout);
    const stderr = asUtf8((result as any)?.stderr);
    const exit_code = normalizeProcessExitCode(
      (result as any)?.code,
      stdout,
      stderr,
    );
    return {
      project_id: project.project_id,
      path: path?.trim() || ".",
      pattern,
      stdout,
      stderr,
      exit_code,
      truncated: normalizeBoolean((result as any)?.truncated),
    };
  }

  async function projectFileFdData({
    ctx,
    projectIdentifier,
    pattern,
    path,
    timeoutMs,
    maxBytes,
    options,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    pattern?: string;
    path?: string;
    timeoutMs: number;
    maxBytes: number;
    options?: string[];
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    const { project, fs } = await resolveProjectFilesystem(
      ctx,
      projectIdentifier,
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
    const exit_code = normalizeProcessExitCode(
      (result as any)?.code,
      stdout,
      stderr,
    );
    return {
      project_id: project.project_id,
      path: path?.trim() || ".",
      pattern: pattern?.trim() || null,
      stdout,
      stderr,
      exit_code,
      truncated: normalizeBoolean((result as any)?.truncated),
    };
  }

  async function runProjectFileCheck({
    ctx,
    projectIdentifier,
    pathPrefix,
    timeoutMs,
    maxBytes,
    keep,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    pathPrefix?: string;
    timeoutMs: number;
    maxBytes: number;
    keep: boolean;
  }): Promise<ProjectFileCheckReport> {
    const project = await resolveProjectFromArgOrContext(
      ctx,
      projectIdentifier,
    );
    const prefix = normalizeProjectPathPrefix(pathPrefix);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempPath = joinProjectPath(prefix, runId);
    const fileName = "probe.txt";
    const filePath = joinProjectPath(tempPath, fileName);
    const marker = `cocalc-cli-check-${runId}`;
    const content = `${marker}\n`;
    const results: ProjectFileCheckResult[] = [];

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
        await projectFileMkdirData({
          ctx,
          projectIdentifier: project.project_id,
          path: tempPath,
          parents: true,
        }),
      () => `created ${tempPath}`,
    );

    await record(
      "put",
      async () =>
        await projectFilePutData({
          ctx,
          projectIdentifier: project.project_id,
          dest: filePath,
          data: Buffer.from(content),
          parents: true,
        }),
      (value: any) =>
        `uploaded ${value?.bytes ?? Buffer.byteLength(content)} bytes`,
    );

    await record(
      "list",
      async () => {
        const rows = await projectFileListData({
          ctx,
          projectIdentifier: project.project_id,
          path: tempPath,
        });
        assertProjectCheck(
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
        const data = await projectFileCatData({
          ctx,
          projectIdentifier: project.project_id,
          path: filePath,
        });
        assertProjectCheck(
          `${data.content ?? ""}` === content,
          "cat content mismatch",
        );
        return data;
      },
      () => `read ${filePath}`,
    );

    await record(
      "get",
      async () => {
        const data = await projectFileGetData({
          ctx,
          projectIdentifier: project.project_id,
          src: filePath,
        });
        const decoded = Buffer.from(
          `${data.content_base64 ?? ""}`,
          "base64",
        ).toString("utf8");
        assertProjectCheck(decoded === content, "get content mismatch");
        return data;
      },
      () => `downloaded ${filePath}`,
    );

    await record(
      "rg",
      async () => {
        const data = await projectFileRgData({
          ctx,
          projectIdentifier: project.project_id,
          pattern: marker,
          path: tempPath,
          timeoutMs,
          maxBytes,
          options: ["-F"],
        });
        assertProjectCheck(
          Number(data.exit_code ?? 1) === 0,
          `rg exit_code=${data.exit_code ?? "unknown"}`,
        );
        assertProjectCheck(
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
        const data = await projectFileFdData({
          ctx,
          projectIdentifier: project.project_id,
          pattern: fileName,
          path: tempPath,
          timeoutMs,
          maxBytes,
        });
        assertProjectCheck(
          Number(data.exit_code ?? 1) === 0,
          `fd exit_code=${data.exit_code ?? "unknown"}`,
        );
        assertProjectCheck(
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
          await projectFileRmData({
            ctx,
            projectIdentifier: project.project_id,
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
        await projectFileRmData({
          ctx,
          projectIdentifier: project.project_id,
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
      project_id: project.project_id,
      project_title: project.title,
      temp_path: tempPath,
      kept: keep,
      total: results.length,
      passed,
      failed,
      skipped,
      results,
    };
  }

  async function runProjectFileCheckBench({
    ctx,
    projectIdentifier,
    pathPrefix,
    timeoutMs,
    maxBytes,
    keep,
    runs,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    pathPrefix?: string;
    timeoutMs: number;
    maxBytes: number;
    keep: boolean;
    runs: number;
  }): Promise<ProjectFileCheckBenchReport> {
    const runResults: ProjectFileCheckBenchRun[] = [];
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
      const report = await runProjectFileCheck({
        ctx,
        projectIdentifier,
        pathPrefix,
        timeoutMs,
        maxBytes,
        keep,
      });
      const durationMs = Date.now() - started;
      workspaceId = report.project_id;
      workspaceTitle = report.project_title;

      const firstFailure = report.results.find((x) => x.status === "fail");
      runResults.push({
        run,
        ok: report.ok,
        duration_ms: durationMs,
        passed: report.passed,
        failed: report.failed,
        skipped: report.skipped,
        temp_path: report.temp_path,
        first_failure: firstFailure
          ? `${firstFailure.step}: ${firstFailure.detail}`
          : null,
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

    const totalDurationMs = runResults.reduce(
      (sum, row) => sum + row.duration_ms,
      0,
    );
    const okRuns = runResults.filter((x) => x.ok).length;
    const failedRuns = runResults.length - okRuns;
    const minDurationMs =
      runResults.length > 0
        ? Math.min(...runResults.map((x) => x.duration_ms))
        : 0;
    const maxDurationMs =
      runResults.length > 0
        ? Math.max(...runResults.map((x) => x.duration_ms))
        : 0;

    const aggregatedSteps: ProjectFileCheckBenchStepStat[] = Array.from(
      stepStats.entries(),
    )
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
      project_id: workspaceId,
      project_title: workspaceTitle,
      runs: runResults.length,
      ok_runs: okRuns,
      failed_runs: failedRuns,
      total_duration_ms: totalDurationMs,
      avg_duration_ms: runResults.length
        ? Math.round(totalDurationMs / runResults.length)
        : 0,
      min_duration_ms: minDurationMs,
      max_duration_ms: maxDurationMs,
      run_results: runResults,
      step_stats: aggregatedSteps,
    };
  }

  return {
    projectFileListData,
    projectFileCatData,
    projectFilePutData,
    projectFileGetData,
    projectFileRmData,
    projectFileMkdirData,
    projectFileRgData,
    projectFileFdData,
    runProjectFileCheck,
    runProjectFileCheckBench,
    parsePositiveInteger,
  };
}
