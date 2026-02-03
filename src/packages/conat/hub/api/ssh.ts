import { requireSignedIn } from "./util";

export const ssh = {
  listSessionsUI: requireSignedIn,
  connectSessionUI: requireSignedIn,
  stopSessionUI: requireSignedIn,
  statusSessionUI: requireSignedIn,
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
    };
  }) => Promise<ConnectUiResult>;
  stopSessionUI: (opts: { target: string }) => Promise<void>;
  statusSessionUI: (opts: { target: string }) => Promise<string>;
}
