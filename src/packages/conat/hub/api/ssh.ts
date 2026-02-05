import { requireSignedIn } from "./util";

export const ssh = {
  listSessionsUI: requireSignedIn,
  connectSessionUI: requireSignedIn,
  addSessionUI: requireSignedIn,
  deleteSessionUI: requireSignedIn,
  stopSessionUI: requireSignedIn,
  upgradeSessionUI: requireSignedIn,
  upgradeLocalUI: requireSignedIn,
  statusSessionUI: requireSignedIn,
  getUpgradeInfoUI: requireSignedIn,
};

export type SshSessionRow = {
  target: string;
  localPort?: number;
  lastUsed?: string;
  lastStopped?: string;
  status?: string;
  tunnelActive?: boolean;
};

export type ConnectUiResult = {
  url: string;
  localPort: number;
  remotePort: number;
};

export type UpgradeInfo = {
  currentVersion?: string;
  latestVersion?: string;
  upgradeAvailable: boolean;
  os?: string;
  arch?: string;
  checkedAt: string;
  error?: string;
};

export type UpgradeInfoPayload = {
  local?: UpgradeInfo;
  remotes: Record<string, UpgradeInfo>;
};

export interface Ssh {
  listSessionsUI: (opts?: { withStatus?: boolean }) => Promise<SshSessionRow[]>;
  connectSessionUI: (opts: {
    target: string;
    options?: {
      localPort?: string;
      remotePort?: string;
      noOpen?: boolean;
      noInstall?: boolean;
      upgrade?: boolean;
      forwardOnly?: boolean;
      identity?: string;
      proxyJump?: string;
      logLevel?: string;
      sshArg?: string[];
      localUrl?: string;
      waitForReady?: boolean;
      readyTimeoutMs?: number;
    };
  }) => Promise<ConnectUiResult>;
  addSessionUI: (opts: { target: string }) => Promise<void>;
  deleteSessionUI: (opts: { target: string }) => Promise<void>;
  stopSessionUI: (opts: { target: string }) => Promise<void>;
  upgradeSessionUI: (opts: { target: string; localUrl?: string }) => Promise<void>;
  upgradeLocalUI: () => Promise<void>;
  statusSessionUI: (opts: { target: string }) => Promise<string>;
  getUpgradeInfoUI: (opts?: {
    force?: boolean;
    scope?: "local" | "remote" | "all";
  }) => Promise<UpgradeInfoPayload>;
}
