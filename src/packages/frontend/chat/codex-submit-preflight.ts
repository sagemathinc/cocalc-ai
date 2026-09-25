import { until } from "@cocalc/util/async-utils";
import type {
  CodexPaymentSourceInfo,
  CodexUsageStatusInfo,
} from "@cocalc/conat/hub/api/system";
import { isCodexModelName } from "@cocalc/util/ai/codex";
import { lite } from "@cocalc/frontend/lite";
import type { CodexThreadConfig } from "@cocalc/chat";
import { getCodexSubscriptionConnection } from "@cocalc/frontend/account/codex-usage";
import {
  getProjectStartPolicyBlock,
  throwProjectStartPolicyBlock,
} from "@cocalc/frontend/projects/runtime-start-policy";

export function isCodexPaymentSourceUsable(
  paymentSource?: CodexPaymentSourceInfo,
): boolean {
  return paymentSource?.source != null && paymentSource.source !== "none";
}

export function isCodexPaymentSourceDefinitelyUnconfigured(
  paymentSource?: CodexPaymentSourceInfo,
): boolean {
  return paymentSource?.source === "none";
}

export function isCodexPaymentSourceNeedsUserConfiguration(
  paymentSource?: CodexPaymentSourceInfo,
): boolean {
  return (
    paymentSource?.source === "none" ||
    (paymentSource?.source === "site-api-key" &&
      (paymentSource.siteFundedCodex?.enabled === false ||
        paymentSource.siteAiUsageLimitPositive === false))
  );
}

export function assertCodexFundingModelReady({
  config,
  paymentSource,
}: {
  config: Partial<CodexThreadConfig>;
  paymentSource: CodexPaymentSourceInfo;
}): void {
  const preference = config.paymentSource ?? "auto";
  if (paymentSource.source === "none") {
    throw new Error(
      paymentSource.unavailableReason ||
        "Configure a payment source before starting this turn.",
    );
  }
  if (preference !== "auto" && paymentSource.source !== preference) {
    throw new Error(
      paymentSource.unavailableReason ||
        "The selected payment source is not available yet. Check your payment settings and try again.",
    );
  }
  const policy = paymentSource.siteFundedCodex?.policy;
  if (
    preference === "auto" &&
    paymentSource.source === "site-api-key" &&
    policy &&
    (config.model !== policy.model || config.reasoning !== policy.reasoning)
  ) {
    throw new Error(
      "Automatic funding currently resolves to CoCalc Membership, which uses a different model. Wait for your ChatGPT Plan to load or select CoCalc Membership explicitly.",
    );
  }
}

export function shouldUseExplicitMembershipModel({
  preference,
  paymentSource,
}: {
  preference?: string;
  paymentSource?: CodexPaymentSourceInfo;
}): boolean {
  return (
    preference === "site-api-key" &&
    paymentSource?.source === "site-api-key" &&
    paymentSource.siteFundedCodex?.enabled === true
  );
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

export async function codexConnectionNeedsAttentionAfterSubmit({
  fetchPaymentSource,
  fetchUsageStatus,
}: {
  fetchPaymentSource: () => Promise<CodexPaymentSourceInfo | undefined>;
  fetchUsageStatus: () => Promise<CodexUsageStatusInfo>;
}): Promise<boolean> {
  const paymentSource = await fetchPaymentSource();
  if (isCodexPaymentSourceNeedsUserConfiguration(paymentSource)) return true;
  if (paymentSource?.source !== "subscription") return false;
  return (
    getCodexSubscriptionConnection(await fetchUsageStatus()).status !==
    "connected"
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
