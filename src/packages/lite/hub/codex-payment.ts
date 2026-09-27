import { account_id as ACCOUNT_ID } from "@cocalc/backend/data";
import type { CodexPaymentSourceInfo } from "@cocalc/conat/hub/api/system";
import type { CodexPaymentSourcePreference } from "@cocalc/util/ai/codex";
import {
  getLiteCredential,
  getLiteCliApiKey,
  listLiteCredentials,
} from "./codex-credentials";
import { getLiteServerSettings } from "./settings";

function parseMap(raw = ""): Record<string, string> {
  try {
    const parsed = JSON.parse(raw);
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && !!entry[1].trim(),
      ),
    );
  } catch {
    return {};
  }
}

export function getLiteCodexApiKeys(accountId: string, projectId?: string) {
  const settings = getLiteServerSettings();
  return {
    "project-api-key": projectId
      ? (
          parseMap(process.env.COCALC_CODEX_AUTH_PROJECT_OPENAI_KEYS_JSON)[
            projectId
          ] ||
          process.env.COCALC_CODEX_AUTH_PROJECT_OPENAI_KEY ||
          ""
        ).trim()
      : "",
    "account-api-key": (
      parseMap(process.env.COCALC_CODEX_AUTH_ACCOUNT_OPENAI_KEYS_JSON)[
        accountId
      ] ||
      process.env.OPENAI_API_KEY ||
      process.env.COCALC_OPENAI_API_KEY ||
      process.env.COCALC_CODEX_AUTH_ACCOUNT_OPENAI_KEY ||
      ""
    ).trim(),
    "site-api-key": settings?.openai_enabled
      ? `${settings.openai_api_key ?? ""}`.trim()
      : "",
  };
}

export async function getLiteCodexPaymentSource(
  opts: {
    account_id?: string;
    project_id?: string;
    preference?: CodexPaymentSourcePreference;
    credential_id?: string;
  } = {},
): Promise<CodexPaymentSourceInfo> {
  const owner = opts.account_id?.trim() || ACCOUNT_ID;
  const preference =
    opts.preference ?? (opts.credential_id ? "subscription" : "auto");
  if (preference === "subscription-credential" && !opts.credential_id) {
    throw Error("An explicit ChatGPT subscription is required.");
  }
  if (
    opts.credential_id &&
    preference !== "subscription" &&
    preference !== "subscription-credential"
  ) {
    throw Error("credential_id requires the subscription payment source");
  }
  const rows = listLiteCredentials(owner);
  const selected = opts.credential_id
    ? rows.find(({ id }) => id === opts.credential_id)
    : rows.find((row) => row.metadata?.cocalc_default);
  const credential = selected
    ? getLiteCredential(owner, selected.id)
    : undefined;
  const keys = getLiteCodexApiKeys(owner, opts.project_id);
  const hasSiteApiKey =
    !!keys["site-api-key"] || process.env.COCALC_ACP_MODE === "mock";
  const availability = {
    subscription: !!credential,
    "project-api-key": !!keys["project-api-key"],
    "account-api-key": !!keys["account-api-key"],
    "site-api-key": hasSiteApiKey,
    "shared-home": !!getLiteCliApiKey(),
  };
  let source: CodexPaymentSourceInfo["source"] = "none";
  if (preference === "auto") {
    source =
      (
        [
          "subscription",
          "project-api-key",
          "account-api-key",
          "site-api-key",
          "shared-home",
        ] as const
      ).find((key) => availability[key]) ?? "none";
  } else {
    const wanted =
      preference === "subscription-credential" ? "subscription" : preference;
    if (availability[wanted]) source = wanted;
  }
  return {
    source,
    preference,
    project_id: opts.project_id,
    hasSubscription: !!credential,
    credentialId: source === "subscription" ? credential?.id : undefined,
    subscriptionRevision: credential?.revision,
    subscriptions: rows.map((row) => ({
      id: row.id,
      label: row.metadata?.label,
      plan: row.metadata?.plan_type,
      isDefault: row.metadata?.cocalc_default,
      updatedAt: row.updated.toISOString(),
    })),
    hasProjectApiKey: availability["project-api-key"],
    hasAccountApiKey: availability["account-api-key"],
    hasSiteApiKey,
    sharedHomeMode: availability["shared-home"] ? "fallback" : "disabled",
    unavailableReason:
      source === "none" && preference !== "auto"
        ? "The selected Codex payment source is unavailable. Reconnect or select another source."
        : undefined,
  };
}
