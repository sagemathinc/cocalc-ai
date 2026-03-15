import type { ChildProcess } from "node:child_process";

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
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }) => Promise<{
    proc: ChildProcess;
    cmd: string;
    args: string[];
    cwd?: string;
    authSource?: string;
    containerPathMap?: CodexProjectContainerPathMap;
    appServerLogin?: CodexAppServerLoginHint;
    handleAppServerRequest?: CodexAppServerRequestHandler;
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
