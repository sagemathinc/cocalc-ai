import type { ChildProcess } from "node:child_process";
import type {
  SiteFundedCodexPolicy,
  SiteFundedCodexReservation,
} from "@cocalc/util/ai/site-funded-codex";
import type { CodexPaymentSourcePreference } from "@cocalc/util/ai/codex";
import type {
  AcpAttentionQuestion,
  AcpAttentionRecord,
  AcpChatContext,
  AcpStreamPayload,
} from "@cocalc/conat/ai/acp/types";

export type CodexSiteFundedTurnRequest = {
  fundedTurnId: string;
  idempotencyKey: string;
  path?: string;
};

export type CodexSiteFundedTurnRuntime = {
  reservation: SiteFundedCodexReservation;
  policy: SiteFundedCodexPolicy;
  providerBaseUrl: string;
  providerToken: string;
  finish: (opts: {
    status: "committed" | "interrupted" | "failed" | "released";
    outcome?: string;
  }) => Promise<void>;
  beginTurn: (
    request: CodexSiteFundedTurnRequest,
  ) => Promise<CodexSiteFundedTurnRuntime>;
  close: () => Promise<void>;
};

export type CodexProjectSpawnOptions = {
  projectId: string;
  accountId?: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  forceRefreshSiteKey?: boolean;
};

export type CodexProjectContainerPathMap = {
  rootHostPath?: string;
  scratchHostPath?: string;
};

export type CodexAppServerLoginHint =
  | {
      type: "apiKey";
      apiKey: string;
    }
  | {
      type: "chatgptAuthTokens";
      accessToken: string;
      chatgptAccountId: string;
      chatgptPlanType?: string;
    };

export type CodexAppServerRequest = {
  id: string | number;
  method: string;
  params?: any;
};

export type CodexAppServerRequestHandler = (
  request: CodexAppServerRequest,
) => Promise<any>;

export type CodexAttentionContext = {
  projectId: string;
  accountId: string;
  chat?: AcpChatContext;
  threadId: string;
  turnId: string;
  stream: (payload?: AcpStreamPayload | null) => Promise<void>;
};

export type CodexAttentionHandler = {
  requestSyncQuestion: (opts: {
    requestId: string;
    itemId: string;
    isBlocking: boolean;
    autoResolutionMs?: number;
    questions: AcpAttentionQuestion[];
    context: CodexAttentionContext;
    signal: AbortSignal;
  }) => Promise<Record<string, { answers: string[] }>>;
  createAsyncQuestion: (opts: {
    itemId: string;
    questions: AcpAttentionQuestion[];
    context: CodexAttentionContext;
  }) => Promise<AcpAttentionRecord>;
  serverRequestResolved?: (opts: {
    requestId: string;
    context?: CodexAttentionContext;
  }) => void | Promise<void>;
  runtimeClosed?: (context?: CodexAttentionContext) => void | Promise<void>;
};

export type CodexProjectSpawner = {
  spawnCodexExec: (opts: CodexProjectSpawnOptions) => Promise<{
    proc: ChildProcess;
    cmd: string;
    args: string[];
    cwd?: string;
    authSource?: string;
    containerPathMap?: CodexProjectContainerPathMap;
  }>;
  spawnCodexAppServer?: (opts: {
    projectId: string;
    accountId?: string;
    agentSessionKey?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    touchReason?: string | false;
    siteFundedTurn?: CodexSiteFundedTurnRequest;
    paymentSource?: CodexPaymentSourcePreference;
  }) => Promise<{
    proc: ChildProcess;
    cmd: string;
    args: string[];
    logArgs?: string;
    cwd?: string;
    authSource?: string;
    containerPathMap?: CodexProjectContainerPathMap;
    appServerLogin?: CodexAppServerLoginHint;
    handleAppServerRequest?: CodexAppServerRequestHandler;
    runtimeEnv?: Record<string, string>;
    setAgentSessionKey?: (agentSessionKey: string) => Promise<void>;
    siteFundedTurn?: CodexSiteFundedTurnRuntime;
  }>;
};

let codexProjectSpawner: CodexProjectSpawner | null = null;

export function setCodexProjectSpawner(
  spawner: CodexProjectSpawner | null,
): void {
  codexProjectSpawner = spawner;
}

export function getCodexProjectSpawner(): CodexProjectSpawner | null {
  return codexProjectSpawner;
}
