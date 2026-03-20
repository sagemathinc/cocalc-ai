import path from "node:path";
import type { CodexSessionConfig } from "@cocalc/util/ai/codex";

let preferContainerOverride: boolean | undefined;

export function setPreferContainerExecutor(force: boolean): void {
  preferContainerOverride = force;
}

export function preferContainerExecutor(): boolean {
  // Explicit opt-in to container executor; default remains local to avoid
  // surprises in lite/single-user mode.
  if (preferContainerOverride !== undefined) return preferContainerOverride;
  return process.env.COCALC_ACP_EXECUTOR === "container";
}

export function resolveWorkspaceRoot(
  config: CodexSessionConfig | undefined,
): string {
  const requested = config?.workingDirectory;
  if (preferContainerExecutor()) {
    // In launchpad/project-host mode Codex now runs fully inside the project
    // container, so the provided workingDirectory is already an in-project
    // absolute path. Do not reinterpret or rewrite it here; only fall back to
    // /root when nothing was provided.
    return requested || "/root";
  }
  // Lite/local mode: respect absolute working dir; otherwise resolve from HOME.
  const home = process.env.HOME ?? process.cwd();
  if (!requested) return home;
  return path.isAbsolute(requested) ? requested : path.resolve(home, requested);
}
