/**
 * Request a document build (LaTeX, R Markdown, Quarto) in a project.
 *
 * The build pipeline lives in the frame editors -- they own the configured
 * build command, the log parsing and the build-log / error panels.  Rather than
 * reproducing any of that, this command starts a short async exec job in the
 * document's build job group.  Every open editor for that path already watches
 * that group and re-runs its own build when a job appears, so the panels the
 * user is looking at refresh.
 *
 * Unlike `cocalc browser exec 'api.editor.build(...)'` this needs no raw
 * browser JavaScript, so it works with the default browser_raw_exec_policy.
 *
 * NOTE: agents are told to use this command by name, so its surface is part of a
 * contract that is not enforced by the type system.  If the command name, the
 * path argument or `--wait` changes, update the prompts that spell it out, or
 * agents will keep calling an interface that no longer exists:
 *
 * - getCoCalcRuntimeGuidanceHeader in @cocalc/ai/acp/codex-app-server -- the
 *   general agent preamble, which every chat turn carries
 * - createNavigatorIntentMessage in
 *   @cocalc/frontend/frame-editors/ai/help-me-fix-utils -- the "Fix with Agent"
 *   prompt, which also records the command under `post_fix_build` metadata
 *
 * See also the same note in ./jupyter.ts for notebook execution.
 */
import { Command } from "commander";

import { randomUUID } from "node:crypto";

import { documentBuildResultSubject } from "@cocalc/conat/project/document-build";
import {
  buildJobGroup,
  buildRequestJobKey,
  canonicalBuildPath,
  documentExtension,
  isBuildableDocument,
  BUILDABLE_EXTENSIONS,
  type DocumentBuildResult,
} from "@cocalc/util/document-build";
import type { ExecuteCodeOutput } from "@cocalc/util/types/execute-code";

import type { ProjectCommandDeps } from "../project";

// The job is only a trigger: watchers react to any job in the group, and
// follow_project_build() reads nothing from it but the aggregate.
export const BUILD_TRIGGER_COMMAND = "true";
export const DEFAULT_BUILD_TRIGGER_TIMEOUT_S = 30;
export const DEFAULT_BUILD_WAIT_TIMEOUT_S = 300;
export const MAX_BUILD_LOG_CHARS = 20_000;

export function normalizeBuildPath(path: unknown): string {
  const cleanPath = `${path ?? ""}`.trim();
  if (!cleanPath) {
    throw new Error("path must be specified");
  }
  if (!cleanPath.startsWith("/")) {
    throw new Error("path must be absolute");
  }
  if (!isBuildableDocument(cleanPath)) {
    const ext = documentExtension(cleanPath);
    throw new Error(
      `'${cleanPath}' is not a buildable document${
        ext ? ` (extension '${ext}')` : ""
      }; expected one of: ${BUILDABLE_EXTENSIONS.join(", ")}`,
    );
  }
  return cleanPath;
}

export function buildTriggerExecOptions({
  path,
  aggregate,
  request_id,
  timeout = DEFAULT_BUILD_TRIGGER_TIMEOUT_S,
}: {
  path: string;
  aggregate: number;
  request_id?: string;
  timeout?: number;
}): Record<string, unknown> {
  return {
    command: BUILD_TRIGGER_COMMAND,
    bash: true,
    timeout,
    err_on_exit: false,
    async_call: true,
    job_group: buildJobGroup(path),
    aggregate,
    ...(request_id
      ? { job_key: buildRequestJobKey({ request_id, path }) }
      : {}),
  };
}

/*
The reply subject is unique to this request, but a build group is shared by a
knitr source and its generated .tex, so two editors can both answer.  Accept
only the one whose logical path is the document we asked about.
*/
export function isBuildResultFor(
  message: Partial<DocumentBuildResult> | undefined,
  request_id: string,
  path?: string,
): boolean {
  if (!message || message.request_id !== request_id) return false;
  if (path == null) return true;
  return `${message.path ?? ""}` === path;
}

export function summarizeBuildResult(result: DocumentBuildResult): {
  exit_code?: number;
  error?: string;
  error_count?: number;
  log?: string;
  jobs?: { name: string; exit_code?: number }[];
} {
  const log = `${result.log ?? ""}`;
  return {
    ...(result.exit_code != null ? { exit_code: result.exit_code } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.error_count != null ? { error_count: result.error_count } : {}),
    ...(log
      ? {
          log:
            log.length > MAX_BUILD_LOG_CHARS
              ? `${log.slice(0, MAX_BUILD_LOG_CHARS)}\n[... truncated ${
                  log.length - MAX_BUILD_LOG_CHARS
                } chars]`
              : log,
        }
      : {}),
    ...(result.jobs?.length ? { jobs: result.jobs } : {}),
  };
}

/*
Wait for the editor that performed the build to report this request's outcome.

Correlating on request_id is required, not a nicety: a document's build group
can contain unrelated builds, and a LaTeX pipeline runs several stages whose
individual exit codes are not the result of the build (sagetex even re-runs
latex afterwards with a content-hash aggregate).  Only the editor knows when
its pipeline finished.

The build runs in the frontend, so this resolves only while some client has the
document open; it times out rather than hanging.
*/
async function waitForBuildResult({
  subscription,
  request_id,
  path,
  timeoutMs,
}: {
  subscription: { close: () => void; [Symbol.asyncIterator]: any };
  request_id: string;
  path: string;
  timeoutMs: number;
}): Promise<DocumentBuildResult | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  const consume = (async (): Promise<DocumentBuildResult | undefined> => {
    for await (const mesg of subscription as any) {
      const data = mesg?.data as DocumentBuildResult | undefined;
      if (isBuildResultFor(data, request_id, path)) return data;
    }
    return undefined;
  })();
  try {
    return await Promise.race([consume, timeout]);
  } finally {
    if (timer != null) clearTimeout(timer);
    consume.catch(() => {});
  }
}

export function registerProjectBuildCommands(
  project: Command,
  deps: ProjectCommandDeps,
): void {
  const { withContext, resolveProjectProjectApi, resolveProjectConatClient } =
    deps;

  project
    .command("build <path>")
    .description(
      "request a document build (LaTeX, R Markdown, Quarto) so open editors rebuild and refresh their build log",
    )
    .option("-w, --project <project>", "project id or name")
    .option(
      "--timeout <seconds>",
      "timeout for the trigger job",
      `${DEFAULT_BUILD_TRIGGER_TIMEOUT_S}`,
    )
    .option(
      "--wait",
      "wait for a connected editor to finish the build and report its exit code and log",
    )
    .option(
      "--wait-timeout <seconds>",
      "how long --wait waits for the build to finish",
      `${DEFAULT_BUILD_WAIT_TIMEOUT_S}`,
    )
    .action(
      async (
        path: string,
        opts: {
          project?: string;
          timeout?: string;
          wait?: boolean;
          waitTimeout?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "project build", async (ctx: any) => {
          const cleanPath = normalizeBuildPath(path);
          const timeout = Number.parseFloat(`${opts.timeout ?? ""}`);
          const waitTimeout = Number.parseFloat(`${opts.waitTimeout ?? ""}`);
          const waitTimeoutMs =
            (Number.isFinite(waitTimeout) && waitTimeout > 0
              ? waitTimeout
              : DEFAULT_BUILD_WAIT_TIMEOUT_S) * 1000;
          const resolved = await resolveProjectProjectApi(ctx, opts.project);
          const project_id = resolved.project?.project_id;
          const job_group = buildJobGroup(cleanPath);
          const request_id = randomUUID();
          const base = {
            path: cleanPath,
            ext: documentExtension(cleanPath),
            // knitr sources build via a derived .tex, which is the name the
            // editor watches
            build_path: canonicalBuildPath(cleanPath),
            project_id,
            job_group,
            request_id,
          };

          // Subscribe before triggering so a fast build cannot be missed.
          let subscription: any;
          if (opts.wait) {
            const conat = await resolveProjectConatClient(ctx, project_id);
            subscription = await conat.client.subscribe(
              documentBuildResultSubject({ project_id, request_id }),
            );
          }
          try {
            const aggregate = Date.now();
            const result: ExecuteCodeOutput = await resolved.api.system.exec(
              buildTriggerExecOptions({
                path: cleanPath,
                aggregate,
                request_id,
                ...(Number.isFinite(timeout) && timeout > 0 ? { timeout } : {}),
              }),
            );
            const job_id =
              result && "job_id" in result
                ? (result as { job_id: string }).job_id
                : undefined;
            if (!opts.wait) {
              return {
                ...base,
                aggregate,
                requested: true,
                awaited: false,
                ...(job_id ? { job_id } : {}),
              };
            }
            const built = await waitForBuildResult({
              subscription,
              request_id,
              path: cleanPath,
              timeoutMs: waitTimeoutMs,
            });
            if (built == null) {
              return {
                ...base,
                aggregate,
                requested: true,
                awaited: false,
                timed_out: true,
                ...(job_id ? { job_id } : {}),
                message: `no connected client reported a build within ${
                  waitTimeoutMs / 1000
                }s; the build runs in an open editor, so ${cleanPath} must be open somewhere`,
              };
            }
            return {
              ...base,
              aggregate,
              requested: true,
              awaited: true,
              ...(job_id ? { job_id } : {}),
              build: summarizeBuildResult(built),
            };
          } finally {
            subscription?.close();
          }
        });
      },
    );
}
