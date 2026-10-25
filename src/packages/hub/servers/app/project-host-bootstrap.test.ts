import type { AddressInfo } from "node:net";
import express from "express";

const exchangeMock = jest.fn();
const warnMock = jest.fn();
const verifyMock = jest.fn();
const mergeMetadataMock = jest.fn();

jest.mock("@cocalc/server/project-host/bootstrap-token", () => ({
  exchangeProjectHostBootstrapToken: (...args: any[]) => exchangeMock(...args),
  verifyProjectHostToken: (...args: any[]) => verifyMock(...args),
}));

jest.mock("@cocalc/database/postgres/project-hosts", () => ({
  mergeProjectHostMetadataObject: (...args: any[]) =>
    mergeMetadataMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: jest.fn() }),
}));

jest.mock("@cocalc/server/cloud/bootstrap-host", () => ({
  buildBootstrapScriptWithStatus: jest.fn(),
}));

jest.mock("@cocalc/server/launchpad/mode", () => ({
  getLaunchpadLocalConfig: jest.fn(() => ({})),
}));

jest.mock("@cocalc/server/launchpad/bootstrap-url", () => ({
  resolveLaunchpadBootstrapUrl: jest.fn(),
}));

jest.mock("@cocalc/server/provider-setup/challenges", () => ({
  uploadProviderSetupChallengePayload: jest.fn(),
}));

jest.mock(
  "@cocalc/hub/logger",
  () => ({
    getLogger: () => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: (...args: any[]) => warnMock(...args),
    }),
  }),
  { virtual: true },
);

import initProjectHostBootstrap from "./project-host-bootstrap";

describe("project-host bootstrap token exchange routes", () => {
  async function request(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ) {
    const app = express();
    const router = express.Router();
    initProjectHostBootstrap(router);
    app.use(router);
    const server = await new Promise<ReturnType<typeof app.listen>>(
      (resolve) => {
        const next = app.listen(0, "127.0.0.1", () => resolve(next));
      },
    );
    try {
      const { port } = server.address() as AddressInfo;
      return await fetch(`http://127.0.0.1:${port}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Authorization: "Bearer boot-token",
          "Content-Type": "application/json",
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }

  beforeEach(() => {
    jest.clearAllMocks();
    verifyMock.mockResolvedValue({
      token_id: "token-1",
      host_id: "host-1",
      purpose: "bootstrap",
      expires: new Date(),
    });
  });

  it("mints a master-conat token through the bootstrap exchange", async () => {
    exchangeMock.mockResolvedValue({
      ok: true,
      host_id: "host-1",
      master: { token: "new-master" },
    });
    const response = await request("/project-host/bootstrap/conat");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("new-master");
    expect(exchangeMock).toHaveBeenCalledWith("boot-token", {
      ttlMs: 1000 * 60 * 60 * 24 * 365,
    });
  });

  it("refuses to mint when the exchange is closed", async () => {
    exchangeMock.mockResolvedValue({
      ok: false,
      reason: "exchange_closed",
      host_id: "host-1",
    });
    const response = await request("/project-host/bootstrap/conat");
    expect(response.status).toBe(401);
  });

  it("never logs any part of an unverified bearer value", async () => {
    exchangeMock.mockResolvedValue({ ok: false, reason: "invalid" });
    const response = await request("/project-host/bootstrap/conat");
    expect(response.status).toBe(401);
    const logged = JSON.stringify(warnMock.mock.calls);
    expect(logged).not.toContain("boot-token");
  });

  it("accepts status reports without touching the exchange", async () => {
    const response = await request("/project-host/bootstrap/status", {
      method: "POST",
      body: { status: "done", message: "Bootstrap completed" },
    });
    expect(response.status).toBe(200);
    expect(mergeMetadataMock).toHaveBeenCalled();
    expect(exchangeMock).not.toHaveBeenCalled();
  });
});
