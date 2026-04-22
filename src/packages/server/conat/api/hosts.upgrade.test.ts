export {};

import { EventEmitter } from "node:events";

let queryMock: jest.Mock;
let isAdminMock: jest.Mock;
let siteUrlMock: jest.Mock;
let createBootstrapTokenMock: jest.Mock;
let buildCloudInitStartupScriptMock: jest.Mock;
let delayMock: jest.Mock;
let spawnMock: jest.Mock;
let upgradeHostSoftwareInternalHelperMock: jest.Mock;
let rolloutHostManagedComponentsInternalHelperMock: jest.Mock;
let getHostOwnerBaySshIdentityMock: jest.Mock;
let getRoutedHostControlClientMock: jest.Mock;
let getProviderContextMock: jest.Mock;
let ensureSshAccessMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/database/settings/site-url", () => ({
  __esModule: true,
  default: (...args: any[]) => siteUrlMock(...args),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  __esModule: true,
  getServerSettings: jest.fn(async () => ({})),
}));

jest.mock("@cocalc/server/project-host/bootstrap-token", () => ({
  __esModule: true,
  createProjectHostBootstrapToken: (...args: any[]) =>
    createBootstrapTokenMock(...args),
  revokeProjectHostTokensForHost: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/server/cloud/bootstrap-host", () => ({
  __esModule: true,
  buildCloudInitStartupScript: (...args: any[]) =>
    buildCloudInitStartupScriptMock(...args),
}));

jest.mock("@cocalc/server/cloud/ssh-key", () => ({
  __esModule: true,
  getHostOwnerBaySshIdentity: (...args: any[]) =>
    getHostOwnerBaySshIdentityMock(...args),
  getHostSshPublicKeys: jest.fn(async () => [
    "ssh-ed25519 AAAAOWNER cocalc-host-owner-bay:bay-0",
  ]),
}));

jest.mock("@cocalc/server/project-host/client", () => ({
  __esModule: true,
  getRoutedHostControlClient: (...args: any[]) =>
    getRoutedHostControlClientMock(...args),
}));

jest.mock("@cocalc/server/cloud/provider-context", () => ({
  __esModule: true,
  getProviderContext: (...args: any[]) => getProviderContextMock(...args),
}));

jest.mock("awaiting", () => ({
  __esModule: true,
  delay: (...args: any[]) => delayMock(...args),
}));

jest.mock("node:child_process", () => {
  const actual = jest.requireActual("node:child_process");
  return {
    __esModule: true,
    ...actual,
    spawn: (...args: any[]) => spawnMock(...args),
  };
});

jest.mock("./hosts-software-execution", () => ({
  __esModule: true,
  upgradeHostSoftwareInternalHelper: (...args: any[]) =>
    upgradeHostSoftwareInternalHelperMock(...args),
  rolloutHostManagedComponentsInternalHelper: (...args: any[]) =>
    rolloutHostManagedComponentsInternalHelperMock(...args),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  getLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

const HOST_ID = "2058bae4-d049-40b9-88ba-187a7091da55";
const ACCOUNT_ID = "acct-123";

function makeHostRow({
  version,
  desiredProjectHostVersion,
  lifecycleStatus,
  publicIp,
}: {
  version: string;
  desiredProjectHostVersion?: string;
  lifecycleStatus: string;
  publicIp?: string;
}) {
  const currentLastSeen = new Date().toISOString();
  const desiredVersion = desiredProjectHostVersion ?? version;
  return {
    id: HOST_ID,
    status: "running",
    version,
    last_seen: currentLastSeen,
    metadata: {
      owner: ACCOUNT_ID,
      ...(publicIp
        ? {
            runtime: { public_ip: publicIp, ssh_user: "ubuntu" },
            machine: { cloud: "gcp" },
          }
        : {}),
      software: {
        project_host: desiredVersion,
        project_bundle: "project-bundle-1",
        tools: "tools-1",
      },
      software_inventory: [
        {
          artifact: "project-host",
          current_version: version,
        },
        {
          artifact: "project-bundle",
          current_version: "project-bundle-1",
        },
        {
          artifact: "tools",
          current_version: "tools-1",
        },
      ],
      bootstrap_lifecycle: {
        summary_status: lifecycleStatus,
      },
    },
  };
}

function makeSshChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let script = "";
  child.stdin = {
    end: (value?: string) => {
      script = value ?? "";
      setImmediate(() => {
        child.stdout.emit(
          "data",
          Buffer.from(
            "started bootstrap reconcile pid=123 log=/mnt/cocalc/data/logs/bootstrap-reconcile.log\n",
          ),
        );
        child.emit("close", 0);
      });
    },
  };
  return { child, getScript: () => script };
}

describe("hosts.reconcileHostSoftwareInternal", () => {
  beforeEach(() => {
    jest.resetModules();
    isAdminMock = jest.fn(async () => false);
    siteUrlMock = jest.fn(async () => "https://hub.test");
    createBootstrapTokenMock = jest.fn(async () => ({
      token: "bootstrap-token",
    }));
    buildCloudInitStartupScriptMock = jest.fn(
      async () => "#!/bin/bash\necho hi\n",
    );
    getHostOwnerBaySshIdentityMock = jest.fn(async () => ({
      privateKeyPath: "/tmp/cocalc-owner-bay/id_ed25519",
      publicKey: "ssh-ed25519 AAAAOWNER cocalc-host-owner-bay:bay-0",
    }));
    getRoutedHostControlClientMock = jest.fn(async () => ({
      addHostSshAuthorizedKey: jest.fn(async () => ({ added: true })),
    }));
    ensureSshAccessMock = jest.fn(async () => undefined);
    getProviderContextMock = jest.fn(async () => ({
      entry: {
        provider: {
          ensureSshAccess: ensureSshAccessMock,
        },
      },
      creds: {},
    }));
    delayMock = jest.fn(async () => undefined);
    upgradeHostSoftwareInternalHelperMock = jest.fn(async () => ({
      results: [],
    }));
    rolloutHostManagedComponentsInternalHelperMock = jest.fn(async () => ({
      results: [],
    }));
  });

  it("waits for bootstrap reconcile lifecycle instead of blocking on the ssh session", async () => {
    const ssh = makeSshChild();
    spawnMock = jest.fn(() => ssh.child);

    let pollCount = 0;
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT * FROM project_hosts WHERE id=$1")) {
        return {
          rows: [
            {
              id: HOST_ID,
              status: "running",
              metadata: {
                owner: ACCOUNT_ID,
                runtime: {
                  instance_id: "host-instance",
                  public_ip: "34.11.143.149",
                  ssh_user: "ubuntu",
                },
                machine: { cloud: "gcp" },
                bootstrap: {
                  status: "done",
                  updated_at: "2026-04-01T21:00:00Z",
                  message: "Host software reconciled",
                },
                bootstrap_lifecycle: {
                  summary_status: "in_sync",
                  last_reconcile_finished_at: "2026-04-01T21:00:00Z",
                },
              },
            },
          ],
        };
      }
      if (sql.includes("SELECT status, deleted, metadata FROM project_hosts")) {
        pollCount += 1;
        if (pollCount === 1) {
          return {
            rows: [
              {
                status: "running",
                deleted: null,
                metadata: {
                  bootstrap: {
                    status: "error",
                    updated_at: "2026-04-01T21:00:00Z",
                    message: "bootstrap failed (exit 1) at line 206",
                  },
                  bootstrap_lifecycle: {
                    summary_status: "in_sync",
                    last_reconcile_finished_at: "2026-04-01T21:02:00Z",
                    summary_message: "Host software is in sync",
                  },
                },
              },
            ],
          };
        }
        if (pollCount === 2) {
          return {
            rows: [
              {
                status: "running",
                deleted: null,
                metadata: {
                  bootstrap: {
                    status: "done",
                    updated_at: "2026-04-01T21:00:00Z",
                    message: "Host software reconciled",
                  },
                  bootstrap_lifecycle: {
                    summary_status: "in_sync",
                    last_reconcile_finished_at: "2026-04-01T21:00:00Z",
                  },
                },
              },
            ],
          };
        }
        if (pollCount === 2) {
          return {
            rows: [
              {
                status: "running",
                deleted: null,
                metadata: {
                  bootstrap: {
                    status: "running",
                    updated_at: "2026-04-01T21:01:00Z",
                    message: "Reconciling host software",
                  },
                  bootstrap_lifecycle: {
                    summary_status: "reconciling",
                    current_operation: "reconcile",
                    last_reconcile_started_at: "2026-04-01T21:01:00Z",
                  },
                },
              },
            ],
          };
        }
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              metadata: {
                bootstrap: {
                  status: "done",
                  updated_at: "2026-04-01T21:01:30Z",
                  message: "Host software reconciled",
                },
                bootstrap_lifecycle: {
                  summary_status: "in_sync",
                  last_reconcile_started_at: "2026-04-01T21:01:00Z",
                  last_reconcile_finished_at: "2026-04-01T21:01:30Z",
                },
              },
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { reconcileHostSoftwareInternal } = await import("./hosts");
    await expect(
      reconcileHostSoftwareInternal({
        account_id: ACCOUNT_ID,
        id: HOST_ID,
      }),
    ).resolves.toBeUndefined();

    expect(spawnMock).toHaveBeenCalledWith(
      "ssh",
      expect.arrayContaining([
        "-i",
        "/tmp/cocalc-owner-bay/id_ed25519",
        "ubuntu@34.11.143.149",
        "bash",
        "-se",
      ]),
      expect.any(Object),
    );
    expect(ensureSshAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        instance_id: expect.any(String),
        metadata: expect.objectContaining({
          ssh_public_keys: [
            "ssh-ed25519 AAAAOWNER cocalc-host-owner-bay:bay-0",
          ],
        }),
      }),
      {},
    );
    expect(ssh.getScript()).toContain(
      'BOOTSTRAP_PID="$(sudo -n bash -lc \'nohup bash "$1" >>"$2" 2>&1 </dev/null & echo $!\' -- "$BOOTSTRAP_SH" "$BOOTSTRAP_LOG")"',
    );
  });

  it("ignores a stale bootstrap error once lifecycle evidence is newer", async () => {
    const ssh = makeSshChild();
    spawnMock = jest.fn(() => ssh.child);

    let pollCount = 0;
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT * FROM project_hosts WHERE id=$1")) {
        return {
          rows: [
            {
              id: HOST_ID,
              status: "running",
              metadata: {
                owner: ACCOUNT_ID,
                runtime: { public_ip: "34.11.143.149", ssh_user: "ubuntu" },
                machine: { cloud: "gcp" },
                bootstrap: {
                  status: "error",
                  updated_at: "2026-04-01T21:00:00Z",
                  message: "bootstrap failed (exit 1) at line 206",
                },
                bootstrap_lifecycle: {
                  summary_status: "in_sync",
                  last_reconcile_finished_at: "2026-04-01T21:02:00Z",
                  summary_message: "Host software is in sync",
                },
              },
            },
          ],
        };
      }
      if (sql.includes("SELECT status, deleted, metadata FROM project_hosts")) {
        pollCount += 1;
        if (pollCount === 1) {
          return {
            rows: [
              {
                status: "running",
                deleted: null,
                metadata: {
                  bootstrap: {
                    status: "error",
                    updated_at: "2026-04-01T21:00:00Z",
                    message: "bootstrap failed (exit 1) at line 206",
                  },
                  bootstrap_lifecycle: {
                    summary_status: "reconciling",
                    current_operation: "reconcile",
                    last_reconcile_started_at: "2026-04-01T21:03:00Z",
                    summary_message: "Reconciling host software",
                  },
                },
              },
            ],
          };
        }
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              metadata: {
                bootstrap: {
                  status: "error",
                  updated_at: "2026-04-01T21:00:00Z",
                  message: "bootstrap failed (exit 1) at line 206",
                },
                bootstrap_lifecycle: {
                  summary_status: "in_sync",
                  last_reconcile_started_at: "2026-04-01T21:03:00Z",
                  last_reconcile_finished_at: "2026-04-01T21:03:30Z",
                  summary_message: "Host software is in sync",
                },
              },
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { reconcileHostSoftwareInternal } = await import("./hosts");
    await expect(
      reconcileHostSoftwareInternal({
        account_id: ACCOUNT_ID,
        id: HOST_ID,
      }),
    ).resolves.toBeUndefined();
  });

  it("prefers runtime reconcile before ssh when host-agent work converges lifecycle", async () => {
    spawnMock = jest.fn(() => {
      throw new Error("ssh should not be used");
    });

    const initialRow = makeHostRow({
      version: "1776405602543",
      desiredProjectHostVersion: "1776486535462",
      lifecycleStatus: "drifted",
    });
    const reconciledRow = makeHostRow({
      version: "1776486535462",
      desiredProjectHostVersion: "1776486535462",
      lifecycleStatus: "in_sync",
    });

    let loadCount = 0;
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT * FROM project_hosts WHERE id=$1")) {
        loadCount += 1;
        return { rows: [loadCount === 1 ? initialRow : reconciledRow] };
      }
      if (sql.includes("SELECT deleted, last_seen FROM project_hosts")) {
        return {
          rows: [
            {
              deleted: null,
              last_seen: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { reconcileHostSoftwareInternal } = await import("./hosts");
    await expect(
      reconcileHostSoftwareInternal({
        account_id: ACCOUNT_ID,
        id: HOST_ID,
      }),
    ).resolves.toBeUndefined();

    expect(upgradeHostSoftwareInternalHelperMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        id: HOST_ID,
        targets: [{ artifact: "project-host", version: "1776486535462" }],
      }),
    );
    expect(rolloutHostManagedComponentsInternalHelperMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        id: HOST_ID,
        components: [
          "project-host",
          "conat-router",
          "conat-persist",
          "acp-worker",
        ],
        reason: "host_software_reconcile",
      }),
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("falls back to ssh after a runtime reconcile failure", async () => {
    const ssh = makeSshChild();
    spawnMock = jest.fn(() => ssh.child);
    upgradeHostSoftwareInternalHelperMock = jest.fn(async () => {
      throw new Error("host control unavailable");
    });

    let pollCount = 0;
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT * FROM project_hosts WHERE id=$1")) {
        return {
          rows: [
            makeHostRow({
              version: "1776405602543",
              desiredProjectHostVersion: "1776486535462",
              lifecycleStatus: "drifted",
              publicIp: "34.11.143.149",
            }),
          ],
        };
      }
      if (sql.includes("SELECT status, deleted, metadata FROM project_hosts")) {
        pollCount += 1;
        if (pollCount === 1) {
          return {
            rows: [
              {
                status: "running",
                deleted: null,
                metadata: {
                  bootstrap: {
                    status: "running",
                    updated_at: "2026-04-01T21:01:00Z",
                    message: "Reconciling host software",
                  },
                  bootstrap_lifecycle: {
                    summary_status: "reconciling",
                    current_operation: "reconcile",
                    last_reconcile_started_at: "2026-04-01T21:01:00Z",
                  },
                },
              },
            ],
          };
        }
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              metadata: {
                bootstrap: {
                  status: "done",
                  updated_at: "2026-04-01T21:01:30Z",
                  message: "Host software reconciled",
                },
                bootstrap_lifecycle: {
                  summary_status: "in_sync",
                  last_reconcile_started_at: "2026-04-01T21:01:00Z",
                  last_reconcile_finished_at: "2026-04-01T21:01:30Z",
                },
              },
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { reconcileHostSoftwareInternal } = await import("./hosts");
    await expect(
      reconcileHostSoftwareInternal({
        account_id: ACCOUNT_ID,
        id: HOST_ID,
      }),
    ).resolves.toBeUndefined();

    expect(upgradeHostSoftwareInternalHelperMock).toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(
      "ssh",
      expect.arrayContaining(["ubuntu@34.11.143.149", "bash", "-se"]),
      expect.any(Object),
    );
  });
});
