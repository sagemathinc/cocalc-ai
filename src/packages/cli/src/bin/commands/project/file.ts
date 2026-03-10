/**
 * Project file transfer and inspection commands.
 *
 * Handles list/cat/put/get/rm/mkdir plus search and benchmarks, with support
 * for both direct hub calls and daemon-transported file operations.
 */
import { dirname } from "node:path";
import { Command } from "commander";

import type { ProjectCommandDeps } from "../project";

type GlobalOptions = any;
type CommandContext = any;

export function registerProjectFileCommands(
  project: Command,
  deps: ProjectCommandDeps,
): void {
  const {
    withContext,
    globalsFrom,
    shouldUseDaemonForFileOps,
    runDaemonRequestFromCommand,
    emitSuccess,
    isDaemonTransportError,
    emitError,
    cliDebug,
    projectFileListData,
    projectFileCatData,
    emitProjectFileCatHumanContent,
    readFileLocal,
    asObject,
    projectFilePutData,
    mkdirLocal,
    writeFileLocal,
    projectFileGetData,
    projectFileRmData,
    projectFileMkdirData,
    projectFileRgData,
    projectFileFdData,
    contextForGlobals,
    runProjectFileCheckBench,
    printArrayTable,
    runProjectFileCheck,
    closeCommandContext,
    parsePositiveInteger,
  } = deps;

  const file = project.command("file").description("project file operations");

  file
    .command("list [path]")
    .description("list files in a project directory")
    .option("-w, --project <project>", "project id or name")
    .action(
      async (
        path: string | undefined,
        opts: { project?: string },
        command: Command,
      ) => {
        const globals = globalsFrom(command);
        if (shouldUseDaemonForFileOps(globals)) {
          try {
            const response = await runDaemonRequestFromCommand(command, {
              action: "project.file.list",
              payload: {
                project: opts.project,
                path,
              },
            });
            if (!response.ok) {
              throw new Error(response.error ?? "daemon request failed");
            }
            emitSuccess(
              {
                globals,
                apiBaseUrl: response.meta?.api ?? undefined,
                accountId: response.meta?.account_id ?? undefined,
              },
              "project file list",
              response.data,
            );
            return;
          } catch (err) {
            if (!isDaemonTransportError(err)) {
              emitError({ globals }, "project file list", err);
              process.exitCode = 1;
              return;
            }
            cliDebug(
              "project file list daemon unavailable; falling back to direct mode",
              {
                err: err instanceof Error ? err.message : `${err}`,
              },
            );
          }
        }
        await withContext(command, "project file list", async (ctx) => {
          return await projectFileListData({
            ctx,
            projectIdentifier: opts.project,
            path,
          });
        });
      },
    );

  file
    .command("cat <path>")
    .description("print a text file from a project")
    .option("-w, --project <project>", "project id or name")
    .action(
      async (path: string, opts: { project?: string }, command: Command) => {
        const globals = globalsFrom(command);
        if (shouldUseDaemonForFileOps(globals)) {
          try {
            const response = await runDaemonRequestFromCommand(command, {
              action: "project.file.cat",
              payload: {
                project: opts.project,
                path,
              },
            });
            if (!response.ok) {
              throw new Error(response.error ?? "daemon request failed");
            }
            const data = asObject(response.data);
            const content =
              typeof data.content === "string" ? data.content : "";
            if (!globals.json && globals.output !== "json") {
              emitProjectFileCatHumanContent(content);
              return;
            }
            emitSuccess(
              {
                globals,
                apiBaseUrl: response.meta?.api ?? undefined,
                accountId: response.meta?.account_id ?? undefined,
              },
              "project file cat",
              data,
            );
            return;
          } catch (err) {
            if (!isDaemonTransportError(err)) {
              emitError({ globals }, "project file cat", err);
              process.exitCode = 1;
              return;
            }
            cliDebug(
              "project file cat daemon unavailable; falling back to direct mode",
              {
                err: err instanceof Error ? err.message : `${err}`,
              },
            );
          }
        }
        await withContext(command, "project file cat", async (ctx) => {
          const data = await projectFileCatData({
            ctx,
            projectIdentifier: opts.project,
            path,
          });
          const content = String(data.content ?? "");
          if (!ctx.globals.json && ctx.globals.output !== "json") {
            emitProjectFileCatHumanContent(content);
            return null;
          }
          return data;
        });
      },
    );

  file
    .command("put <src> <dest>")
    .description("upload a local file to a project path")
    .option("-w, --project <project>", "project id or name")
    .option("--no-parents", "do not create destination parent directories")
    .action(
      async (
        src: string,
        dest: string,
        opts: { project?: string; parents?: boolean },
        command: Command,
      ) => {
        const globals = globalsFrom(command);
        const data = await readFileLocal(src);
        if (shouldUseDaemonForFileOps(globals)) {
          try {
            const response = await runDaemonRequestFromCommand(command, {
              action: "project.file.put",
              payload: {
                project: opts.project,
                dest,
                parents: opts.parents !== false,
                content_base64: data.toString("base64"),
              },
            });
            if (!response.ok) {
              throw new Error(response.error ?? "daemon request failed");
            }
            const result = asObject(response.data);
            result.src = src;
            result.dest = dest;
            emitSuccess(
              {
                globals,
                apiBaseUrl: response.meta?.api ?? undefined,
                accountId: response.meta?.account_id ?? undefined,
              },
              "project file put",
              result,
            );
            return;
          } catch (err) {
            if (!isDaemonTransportError(err)) {
              emitError({ globals }, "project file put", err);
              process.exitCode = 1;
              return;
            }
            cliDebug(
              "project file put daemon unavailable; falling back to direct mode",
              {
                err: err instanceof Error ? err.message : `${err}`,
              },
            );
          }
        }
        await withContext(command, "project file put", async (ctx) => {
          const result = await projectFilePutData({
            ctx,
            projectIdentifier: opts.project,
            dest,
            data,
            parents: opts.parents !== false,
          });
          return {
            ...result,
            src,
          };
        });
      },
    );

  file
    .command("get <src> <dest>")
    .description("download a project file to a local path")
    .option("-w, --project <project>", "project id or name")
    .option("--no-parents", "do not create destination parent directories")
    .action(
      async (
        src: string,
        dest: string,
        opts: { project?: string; parents?: boolean },
        command: Command,
      ) => {
        const globals = globalsFrom(command);
        if (shouldUseDaemonForFileOps(globals)) {
          try {
            const response = await runDaemonRequestFromCommand(command, {
              action: "project.file.get",
              payload: {
                project: opts.project,
                src,
              },
            });
            if (!response.ok) {
              throw new Error(response.error ?? "daemon request failed");
            }
            const data = asObject(response.data);
            const encoded =
              typeof data.content_base64 === "string"
                ? data.content_base64
                : "";
            const buffer = Buffer.from(encoded, "base64");
            if (opts.parents !== false) {
              await mkdirLocal(dirname(dest), { recursive: true });
            }
            await writeFileLocal(dest, buffer);
            emitSuccess(
              {
                globals,
                apiBaseUrl: response.meta?.api ?? undefined,
                accountId: response.meta?.account_id ?? undefined,
              },
              "project file get",
              {
                project_id: data.project_id ?? null,
                src,
                dest,
                bytes: buffer.length,
                status: data.status ?? "downloaded",
              },
            );
            return;
          } catch (err) {
            if (!isDaemonTransportError(err)) {
              emitError({ globals }, "project file get", err);
              process.exitCode = 1;
              return;
            }
            cliDebug(
              "project file get daemon unavailable; falling back to direct mode",
              {
                err: err instanceof Error ? err.message : `${err}`,
              },
            );
          }
        }
        await withContext(command, "project file get", async (ctx) => {
          const data = await projectFileGetData({
            ctx,
            projectIdentifier: opts.project,
            src,
          });
          const encoded =
            typeof data.content_base64 === "string" ? data.content_base64 : "";
          const buffer = Buffer.from(encoded, "base64");
          if (opts.parents !== false) {
            await mkdirLocal(dirname(dest), { recursive: true });
          }
          await writeFileLocal(dest, buffer);
          return {
            project_id: data.project_id ?? null,
            src,
            dest,
            bytes: buffer.length,
            status: data.status ?? "downloaded",
          };
        });
      },
    );

  file
    .command("rm <path>")
    .description("remove a path in a project")
    .option("-w, --project <project>", "project id or name")
    .option("-r, --recursive", "remove directories recursively")
    .option("-f, --force", "do not fail if path is missing")
    .action(
      async (
        path: string,
        opts: { project?: string; recursive?: boolean; force?: boolean },
        command: Command,
      ) => {
        const globals = globalsFrom(command);
        if (shouldUseDaemonForFileOps(globals)) {
          try {
            const response = await runDaemonRequestFromCommand(command, {
              action: "project.file.rm",
              payload: {
                project: opts.project,
                path,
                recursive: !!opts.recursive,
                force: !!opts.force,
              },
            });
            if (!response.ok) {
              throw new Error(response.error ?? "daemon request failed");
            }
            emitSuccess(
              {
                globals,
                apiBaseUrl: response.meta?.api ?? undefined,
                accountId: response.meta?.account_id ?? undefined,
              },
              "project file rm",
              response.data,
            );
            return;
          } catch (err) {
            if (!isDaemonTransportError(err)) {
              emitError({ globals }, "project file rm", err);
              process.exitCode = 1;
              return;
            }
            cliDebug(
              "project file rm daemon unavailable; falling back to direct mode",
              {
                err: err instanceof Error ? err.message : `${err}`,
              },
            );
          }
        }
        await withContext(command, "project file rm", async (ctx) => {
          return await projectFileRmData({
            ctx,
            projectIdentifier: opts.project,
            path,
            recursive: !!opts.recursive,
            force: !!opts.force,
          });
        });
      },
    );

  file
    .command("mkdir <path>")
    .description("create a directory in a project")
    .option("-w, --project <project>", "project id or name")
    .option("--no-parents", "do not create parent directories")
    .action(
      async (
        path: string,
        opts: { project?: string; parents?: boolean },
        command: Command,
      ) => {
        const globals = globalsFrom(command);
        if (shouldUseDaemonForFileOps(globals)) {
          try {
            const response = await runDaemonRequestFromCommand(command, {
              action: "project.file.mkdir",
              payload: {
                project: opts.project,
                path,
                parents: opts.parents !== false,
              },
            });
            if (!response.ok) {
              throw new Error(response.error ?? "daemon request failed");
            }
            emitSuccess(
              {
                globals,
                apiBaseUrl: response.meta?.api ?? undefined,
                accountId: response.meta?.account_id ?? undefined,
              },
              "project file mkdir",
              response.data,
            );
            return;
          } catch (err) {
            if (!isDaemonTransportError(err)) {
              emitError({ globals }, "project file mkdir", err);
              process.exitCode = 1;
              return;
            }
            cliDebug(
              "project file mkdir daemon unavailable; falling back to direct mode",
              {
                err: err instanceof Error ? err.message : `${err}`,
              },
            );
          }
        }
        await withContext(command, "project file mkdir", async (ctx) => {
          return await projectFileMkdirData({
            ctx,
            projectIdentifier: opts.project,
            path,
            parents: opts.parents !== false,
          });
        });
      },
    );

  file
    .command("rg <pattern> [path]")
    .description("search project files using ripgrep")
    .option("-w, --project <project>", "project id or name")
    .option("--timeout <seconds>", "ripgrep timeout seconds", "30")
    .option("--max-bytes <bytes>", "max combined output bytes", "20000000")
    .option(
      "--rg-option <arg>",
      "additional ripgrep option (repeatable)",
      (value, prev: string[] = []) => [...prev, value],
      [],
    )
    .action(
      async (
        pattern: string,
        path: string | undefined,
        opts: {
          project?: string;
          timeout?: string;
          maxBytes?: string;
          rgOption?: string[];
        },
        command: Command,
      ) => {
        const globals = globalsFrom(command);
        const timeoutMs = Math.max(
          1,
          (Number(opts.timeout ?? "30") || 30) * 1000,
        );
        const maxBytes = Math.max(
          1024,
          Number(opts.maxBytes ?? "20000000") || 20000000,
        );
        if (shouldUseDaemonForFileOps(globals)) {
          try {
            const response = await runDaemonRequestFromCommand(command, {
              action: "project.file.rg",
              payload: {
                project: opts.project,
                pattern,
                path,
                timeout_ms: timeoutMs,
                max_bytes: maxBytes,
                rg_options: opts.rgOption ?? [],
              },
            });
            if (!response.ok) {
              throw new Error(response.error ?? "daemon request failed");
            }
            const data = asObject(response.data);
            const stdout = typeof data.stdout === "string" ? data.stdout : "";
            const stderr = typeof data.stderr === "string" ? data.stderr : "";
            const exit_code = Number(data.exit_code ?? 1);
            if (!globals.json && globals.output !== "json") {
              if (stdout) process.stdout.write(stdout);
              if (stderr) process.stderr.write(stderr);
              if (exit_code !== 0) process.exitCode = exit_code;
              return;
            }
            emitSuccess(
              {
                globals,
                apiBaseUrl: response.meta?.api ?? undefined,
                accountId: response.meta?.account_id ?? undefined,
              },
              "project file rg",
              data,
            );
            return;
          } catch (err) {
            if (!isDaemonTransportError(err)) {
              emitError({ globals }, "project file rg", err);
              process.exitCode = 1;
              return;
            }
            cliDebug(
              "project file rg daemon unavailable; falling back to direct mode",
              {
                err: err instanceof Error ? err.message : `${err}`,
              },
            );
          }
        }
        await withContext(command, "project file rg", async (ctx) => {
          const data = await projectFileRgData({
            ctx,
            projectIdentifier: opts.project,
            pattern,
            path,
            timeoutMs,
            maxBytes,
            options: opts.rgOption,
          });
          const stdout = typeof data.stdout === "string" ? data.stdout : "";
          const stderr = typeof data.stderr === "string" ? data.stderr : "";
          const exit_code = Number(data.exit_code ?? 1);

          if (!ctx.globals.json && ctx.globals.output !== "json") {
            if (stdout) process.stdout.write(stdout);
            if (stderr) process.stderr.write(stderr);
            if (exit_code !== 0) {
              process.exitCode = exit_code;
            }
            return null;
          }
          return data;
        });
      },
    );

  file
    .command("fd [pattern] [path]")
    .description("find files in a project using fd")
    .option("-w, --project <project>", "project id or name")
    .option("--timeout <seconds>", "fd timeout seconds", "30")
    .option("--max-bytes <bytes>", "max combined output bytes", "20000000")
    .option(
      "--fd-option <arg>",
      "additional fd option (repeatable)",
      (value, prev: string[] = []) => [...prev, value],
      [],
    )
    .action(
      async (
        pattern: string | undefined,
        path: string | undefined,
        opts: {
          project?: string;
          timeout?: string;
          maxBytes?: string;
          fdOption?: string[];
        },
        command: Command,
      ) => {
        const globals = globalsFrom(command);
        const timeoutMs = Math.max(
          1,
          (Number(opts.timeout ?? "30") || 30) * 1000,
        );
        const maxBytes = Math.max(
          1024,
          Number(opts.maxBytes ?? "20000000") || 20000000,
        );
        if (shouldUseDaemonForFileOps(globals)) {
          try {
            const response = await runDaemonRequestFromCommand(command, {
              action: "project.file.fd",
              payload: {
                project: opts.project,
                pattern,
                path,
                timeout_ms: timeoutMs,
                max_bytes: maxBytes,
                fd_options: opts.fdOption ?? [],
              },
            });
            if (!response.ok) {
              throw new Error(response.error ?? "daemon request failed");
            }
            const data = asObject(response.data);
            const stdout = typeof data.stdout === "string" ? data.stdout : "";
            const stderr = typeof data.stderr === "string" ? data.stderr : "";
            const exit_code = Number(data.exit_code ?? 1);
            if (!globals.json && globals.output !== "json") {
              if (stdout) process.stdout.write(stdout);
              if (stderr) process.stderr.write(stderr);
              if (exit_code !== 0) process.exitCode = exit_code;
              return;
            }
            emitSuccess(
              {
                globals,
                apiBaseUrl: response.meta?.api ?? undefined,
                accountId: response.meta?.account_id ?? undefined,
              },
              "project file fd",
              data,
            );
            return;
          } catch (err) {
            if (!isDaemonTransportError(err)) {
              emitError({ globals }, "project file fd", err);
              process.exitCode = 1;
              return;
            }
            cliDebug(
              "project file fd daemon unavailable; falling back to direct mode",
              {
                err: err instanceof Error ? err.message : `${err}`,
              },
            );
          }
        }
        await withContext(command, "project file fd", async (ctx) => {
          const data = await projectFileFdData({
            ctx,
            projectIdentifier: opts.project,
            pattern,
            path,
            timeoutMs,
            maxBytes,
            options: opts.fdOption,
          });
          const stdout = typeof data.stdout === "string" ? data.stdout : "";
          const stderr = typeof data.stderr === "string" ? data.stderr : "";
          const exit_code = Number(data.exit_code ?? 1);

          if (!ctx.globals.json && ctx.globals.output !== "json") {
            if (stdout) process.stdout.write(stdout);
            if (stderr) process.stderr.write(stderr);
            if (exit_code !== 0) {
              process.exitCode = exit_code;
            }
            return null;
          }
          return data;
        });
      },
    );

  file
    .command("check")
    .description("run sanity checks for project file operations")
    .option("-w, --project <project>", "project id or name")
    .option(
      "--path-prefix <path>",
      "temporary project path prefix",
      ".cocalc-cli-check",
    )
    .option("--timeout <seconds>", "timeout seconds for rg/fd checks", "30")
    .option(
      "--max-bytes <bytes>",
      "max combined output bytes for rg/fd checks",
      "20000000",
    )
    .option("--keep", "keep temporary check files in the project")
    .option(
      "--bench",
      "run repeated checks and include timing benchmark summaries",
    )
    .option(
      "--bench-runs <n>",
      "number of benchmark runs when --bench is used",
      "3",
    )
    .action(
      async (
        opts: {
          project?: string;
          pathPrefix?: string;
          timeout?: string;
          maxBytes?: string;
          keep?: boolean;
          bench?: boolean;
          benchRuns?: string;
        },
        command: Command,
      ) => {
        let globals: GlobalOptions = {};
        let ctx: CommandContext | undefined;
        try {
          globals = globalsFrom(command);
          ctx = await contextForGlobals(globals);
          const timeoutMs = Math.max(
            1,
            (Number(opts.timeout ?? "30") || 30) * 1000,
          );
          const maxBytes = Math.max(
            1024,
            Number(opts.maxBytes ?? "20000000") || 20000000,
          );
          if (opts.bench) {
            const benchRuns = parsePositiveInteger(
              opts.benchRuns,
              3,
              "--bench-runs",
            );
            const report = await runProjectFileCheckBench({
              ctx,
              projectIdentifier: opts.project,
              pathPrefix: opts.pathPrefix,
              timeoutMs,
              maxBytes,
              keep: !!opts.keep,
              runs: benchRuns,
            });
            if (ctx.globals.json || ctx.globals.output === "json") {
              emitSuccess(ctx, "project file check", report);
            } else if (!ctx.globals.quiet) {
              printArrayTable(report.run_results.map((x) => ({ ...x })));
              printArrayTable(report.step_stats.map((x) => ({ ...x })));
              console.log(
                `summary: ${report.ok_runs}/${report.runs} successful runs (${report.failed_runs} failed)`,
              );
              console.log(
                `timing_ms: avg=${report.avg_duration_ms} min=${report.min_duration_ms} max=${report.max_duration_ms} total=${report.total_duration_ms}`,
              );
              console.log(`project_id: ${report.project_id}`);
            }
            if (!report.ok) {
              process.exitCode = 1;
            }
          } else {
            const report = await runProjectFileCheck({
              ctx,
              projectIdentifier: opts.project,
              pathPrefix: opts.pathPrefix,
              timeoutMs,
              maxBytes,
              keep: !!opts.keep,
            });

            if (ctx.globals.json || ctx.globals.output === "json") {
              emitSuccess(ctx, "project file check", report);
            } else if (!ctx.globals.quiet) {
              printArrayTable(report.results.map((x) => ({ ...x })));
              console.log(
                `summary: ${report.passed}/${report.total} passed (${report.failed} failed, ${report.skipped} skipped)`,
              );
              console.log(`project_id: ${report.project_id}`);
              console.log(
                `temp_path: ${report.temp_path}${report.kept ? " (kept)" : ""}`,
              );
            }

            if (!report.ok) {
              process.exitCode = 1;
            }
          }
        } catch (error) {
          emitError(
            { globals, apiBaseUrl: ctx?.apiBaseUrl, accountId: ctx?.accountId },
            "project file check",
            error,
          );
          process.exitCode = 1;
        } finally {
          closeCommandContext(ctx);
        }
      },
    );
}
