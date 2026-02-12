import type { CodexReasoningId, CodexSessionMode } from "@cocalc/util/ai/codex";

const SESSION_KEY_GLOBAL = "cocalc:navigator:acp-session";
const SESSION_KEY_PREFIX = "cocalc:navigator:acp-session";
const CONFIG_KEY_GLOBAL = "cocalc:navigator:acp-config";
const CONFIG_KEY_PREFIX = "cocalc:navigator:acp-config";
const TARGET_PROJECT_KEY = "cocalc:navigator:target-project-id";

type StoredNavigatorConfig = {
  model?: string;
  reasoning?: CodexReasoningId;
  sessionMode?: CodexSessionMode;
};

function projectSessionKey(projectId: string): string {
  return `${SESSION_KEY_PREFIX}:${projectId}`;
}

function projectConfigKey(projectId: string): string {
  return `${CONFIG_KEY_PREFIX}:${projectId}`;
}

export function loadNavigatorSessionId(projectId: string): string {
  try {
    const globalValue = localStorage.getItem(SESSION_KEY_GLOBAL);
    if (globalValue?.trim()) {
      return globalValue.trim();
    }
    const legacy = localStorage.getItem(projectSessionKey(projectId));
    if (legacy?.trim()) {
      localStorage.setItem(SESSION_KEY_GLOBAL, legacy.trim());
      return legacy.trim();
    }
  } catch {}
  return "";
}

export function saveNavigatorSessionId(value?: string): void {
  const next = value?.trim() ?? "";
  try {
    if (next) {
      localStorage.setItem(SESSION_KEY_GLOBAL, next);
    } else {
      localStorage.removeItem(SESSION_KEY_GLOBAL);
    }
  } catch {}
}

export function loadNavigatorConfig(
  projectId: string,
): StoredNavigatorConfig | undefined {
  try {
    const globalValue = localStorage.getItem(CONFIG_KEY_GLOBAL);
    if (globalValue?.trim()) {
      return JSON.parse(globalValue);
    }
    const legacy = localStorage.getItem(projectConfigKey(projectId));
    if (legacy?.trim()) {
      localStorage.setItem(CONFIG_KEY_GLOBAL, legacy);
      return JSON.parse(legacy);
    }
  } catch {}
  return undefined;
}

export function saveNavigatorConfig(config: StoredNavigatorConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY_GLOBAL, JSON.stringify(config));
  } catch {}
}

export function loadNavigatorTargetProjectId(fallbackProjectId: string): string {
  try {
    const saved = localStorage.getItem(TARGET_PROJECT_KEY);
    if (saved?.trim()) {
      return saved.trim();
    }
  } catch {}
  return fallbackProjectId;
}

export function saveNavigatorTargetProjectId(projectId?: string): void {
  const next = projectId?.trim() ?? "";
  try {
    if (next) {
      localStorage.setItem(TARGET_PROJECT_KEY, next);
    } else {
      localStorage.removeItem(TARGET_PROJECT_KEY);
    }
  } catch {}
}

export function clearNavigatorTargetProjectId(): void {
  try {
    localStorage.removeItem(TARGET_PROJECT_KEY);
  } catch {}
}

