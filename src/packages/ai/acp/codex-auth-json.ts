import type { CodexAppServerLoginHint } from "./codex-project";

function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  try {
    const payload = Buffer.from(pad, "base64").toString("utf8");
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractChatgptClaims(claims: Record<string, unknown> | undefined): {
  chatgptAccountId?: string;
  chatgptPlanType?: string;
} {
  if (!claims) return {};
  const auth = claims["https://api.openai.com/auth"];
  if (!auth || typeof auth !== "object") return {};
  const chatgptAccountId =
    typeof (auth as any).chatgpt_account_id === "string"
      ? `${(auth as any).chatgpt_account_id}`.trim()
      : undefined;
  const chatgptPlanType =
    typeof (auth as any).chatgpt_plan_type === "string"
      ? `${(auth as any).chatgpt_plan_type}`.trim()
      : undefined;
  return {
    chatgptAccountId: chatgptAccountId || undefined,
    chatgptPlanType: chatgptPlanType || undefined,
  };
}

export function codexAuthJsonToAppServerLogin(
  raw: string | undefined,
): CodexAppServerLoginHint | undefined {
  try {
    if (!raw?.trim()) return undefined;
    const parsed = JSON.parse(raw);
    const tokens = parsed?.tokens;
    const accessToken =
      typeof tokens?.access_token === "string"
        ? tokens.access_token.trim()
        : "";
    if (!accessToken) return undefined;
    const accessClaims = extractChatgptClaims(decodeJwtClaims(accessToken));
    const idToken =
      typeof tokens?.id_token === "string" ? tokens.id_token : undefined;
    const idClaims = extractChatgptClaims(
      idToken ? decodeJwtClaims(idToken) : undefined,
    );
    const chatgptAccountId =
      (typeof tokens?.account_id === "string"
        ? tokens.account_id.trim()
        : "") ||
      accessClaims.chatgptAccountId ||
      idClaims.chatgptAccountId;
    if (!chatgptAccountId) return undefined;
    return {
      type: "chatgptAuthTokens",
      accessToken,
      chatgptAccountId,
      chatgptPlanType: accessClaims.chatgptPlanType ?? idClaims.chatgptPlanType,
    };
  } catch {
    return undefined;
  }
}
