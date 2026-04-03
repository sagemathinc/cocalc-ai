import path from "node:path";
import type { CodexSessionConfig } from "@cocalc/util/ai/codex";
import { DEFAULT_PROJECT_RUNTIME_HOME } from "@cocalc/util/project-runtime";

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
    // absolute path. Canonicalize the runtime home and otherwise leave
    // container paths alone.
    if (!requested) return DEFAULT_PROJECT_RUNTIME_HOME;
    const normalized = path.posix.normalize(requested);
    if (normalized === DEFAULT_PROJECT_RUNTIME_HOME) {
      return DEFAULT_PROJECT_RUNTIME_HOME;
    }
    if (normalized.startsWith(`${DEFAULT_PROJECT_RUNTIME_HOME}/`)) {
      return normalized;
    }
    return requested;
  }
  // Lite/local mode: respect absolute working dir; otherwise resolve from HOME.
  const home = process.env.HOME ?? process.cwd();
  if (!requested) return home;
  return path.isAbsolute(requested) ? requested : path.resolve(home, requested);
}
