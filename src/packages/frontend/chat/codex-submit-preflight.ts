import { until } from "@cocalc/util/async-utils";
import type { CodexPaymentSourceInfo } from "@cocalc/conat/hub/api/system";
import { isCodexModelName } from "@cocalc/util/ai/codex";
import { lite } from "@cocalc/frontend/lite";
import {
  getProjectStartPolicyBlock,
  throwProjectStartPolicyBlock,
} from "@cocalc/frontend/projects/runtime-start-policy";

export function isCodexPaymentSourceUsable(
  paymentSource?: CodexPaymentSourceInfo,
): boolean {
  return paymentSource?.source != null && paymentSource.source !== "none";
}

export function isCodexSubmitTarget({
  newThreadAgentMode,
  existingThreadAgentKind,
  existingThreadAgentModel,
}: {
  newThreadAgentMode?: string | null;
  existingThreadAgentKind?: string | null;
  existingThreadAgentModel?: string | null;
}): boolean {
  return (
    newThreadAgentMode === "codex" ||
    existingThreadAgentKind === "acp" ||
    isCodexModelName(`${existingThreadAgentModel ?? ""}`.trim())
  );
}

export async function ensureProjectRunningForCodex({
  project_id,
  redux,
  timeoutMs = 120_000,
}: {
  project_id?: string;
  redux: {
    getStore: (name: string) => {
      get_state: (project_id: string) => string | undefined;
      get?: (key: string) => any;
      getIn?: (path: string[]) => any;
    };
    getActions: (name: "projects") => {
      start_project: (
        project_id: string,
        opts?: { autostart?: boolean },
      ) => Promise<boolean> | boolean;
    };
  };
  timeoutMs?: number;
}): Promise<void> {
  if (lite) return;
  const normalizedProjectId = `${project_id ?? ""}`.trim();
  if (!normalizedProjectId) {
    throw Error("missing project id");
  }

  const store = redux.getStore("projects");
  const getState = () => store.get_state(normalizedProjectId);
  const initialState = getState();
  if (initialState === "running") return;

  if (initialState !== "starting") {
    const accountStore = redux.getStore("account");
    const block = getProjectStartPolicyBlock({
      project: store.getIn?.(["project_map", normalizedProjectId]),
      account_id: accountStore?.get?.("account_id"),
      is_admin: !!accountStore?.get?.("is_admin"),
      autostart: true,
    });
    if (block) {
      throwProjectStartPolicyBlock(block);
    }
    const didStart = await redux
      .getActions("projects")
      .start_project(normalizedProjectId, { autostart: true });
    const stateAfterStart = getState();
    if (
      didStart === false &&
      stateAfterStart !== "starting" &&
      stateAfterStart !== "running"
    ) {
      throw Error("project did not start");
    }
  }

  await until(() => getState() === "running", {
    min: 250,
    max: 1000,
    timeout: timeoutMs,
  });
}
