import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { account_id as ACCOUNT_ID } from "@cocalc/backend/data";
import {
  getCodexProjectSpawner,
  setCodexProjectSpawner,
  type CodexProjectSpawner,
} from "@cocalc/ai/acp";
import { CODEX_APP_SERVER_FEATURE_ARGS } from "@cocalc/util/ai/codex";
import {
  getLiteCredential,
  getLiteCliApiKey,
  refreshLiteCredential,
  resolveLiteCodexHome,
  touchLiteCredential,
  validateLiteSubscriptionAuth,
} from "./codex-credentials";
import {
  getLiteCodexApiKeys,
  getLiteCodexPaymentSource,
} from "./codex-payment";

export const spawnLiteCodexAppServer: NonNullable<
  CodexProjectSpawner["spawnCodexAppServer"]
> = async (opts) => {
  const owner = opts.accountId || ACCOUNT_ID;
  const stagedLogin = opts.codexHome
    ? validateLiteSubscriptionAuth(
        await readFile(join(opts.codexHome, "auth.json"), "utf8"),
      )
    : undefined;
  const payment = stagedLogin
    ? undefined
    : await getLiteCodexPaymentSource({
        account_id: owner,
        project_id: opts.projectId,
        preference: opts.paymentSource,
        credential_id: opts.credentialId,
      });
  if (!stagedLogin && payment?.source === "none")
    throw Error(payment.unavailableReason || "Codex is not connected.");
  const credential =
    payment?.source === "subscription"
      ? getLiteCredential(owner, payment.credentialId)
      : undefined;
  const keys = getLiteCodexApiKeys(owner, opts.projectId);
  const apiKey =
    payment?.source === "shared-home"
      ? getLiteCliApiKey()
      : payment && keys[payment.source];
  const appServerLogin =
    stagedLogin ??
    credential?.login ??
    (apiKey ? { type: "apiKey" as const, apiKey } : undefined);
  if (!appServerLogin)
    throw Error("The selected Codex credential is unavailable.");
  const cmd = process.env.COCALC_CODEX_BIN?.trim() || "codex";
  // Keep the local session store, but never load/save process authentication
  // through shared auth.json. Each app-server receives its own explicit login.
  const args = [
    "--config",
    'cli_auth_credentials_store="ephemeral"',
    ...CODEX_APP_SERVER_FEATURE_ARGS,
    "app-server",
    "--listen",
    "stdio://",
  ];
  const codexHome = resolveLiteCodexHome();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.env,
    CODEX_HOME: codexHome,
    COCALC_CODEX_HOME: codexHome,
  };
  delete env.OPENAI_API_KEY;
  if (process.env.COCALC_ORIGINAL_HOME)
    env.HOME = process.env.COCALC_ORIGINAL_HOME;
  if (credential && opts.touchReason !== false)
    touchLiteCredential(owner, credential.id);
  const proc = spawn(cmd, args, {
    cwd: opts.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let lastAccessToken = credential?.login.accessToken;
  return {
    proc,
    cmd,
    args,
    cwd: opts.cwd,
    appServerLogin,
    authSource: stagedLogin ? "subscription" : payment?.source,
    credentialId: credential?.id,
    // Revalidate even when the agent reuses a running app-server.
    validateSubscriptionCredential: credential
      ? async () => {
          const latest = getLiteCredential(owner, credential.id);
          if (
            latest.login.chatgptAccountId !== credential.login.chatgptAccountId
          )
            throw Error(
              "ChatGPT subscription identity changed. Start a new turn.",
            );
          touchLiteCredential(owner, credential.id);
        }
      : undefined,
    handleAppServerRequest: async (request) => {
      if (
        request.method !== "account/chatgptAuthTokens/refresh" ||
        !credential ||
        !lastAccessToken
      ) {
        throw Error("ChatGPT authentication needs to be reconnected.");
      }
      const login = await refreshLiteCredential(
        owner,
        credential.id,
        lastAccessToken,
      );
      if (login.chatgptAccountId !== credential.login.chatgptAccountId)
        throw Error("ChatGPT subscription identity changed.");
      lastAccessToken = login.accessToken;
      return {
        accessToken: login.accessToken,
        chatgptAccountId: login.chatgptAccountId,
        chatgptPlanType: login.chatgptPlanType ?? null,
      };
    },
  };
};

export function installLiteCodexSpawner(): void {
  // Project hosts install their own routing/auth implementation; never replace it.
  if (getCodexProjectSpawner()) return;
  setCodexProjectSpawner({
    spawnCodexAppServer: spawnLiteCodexAppServer,
    spawnCodexExec: async () => {
      throw Error("Lite requires the Codex app-server runtime.");
    },
  });
}
