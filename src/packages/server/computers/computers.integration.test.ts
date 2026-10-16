/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Computers at the home bay against real SQL (in-memory PGlite, tables from
// db-schema): pairing through the machine's endpoints, approval, host tokens
// and revocation. The host side is simulated. Run with
// COCALC_TEST_USE_PGLITE=1. Design: src/.agents/computers-direct-host-2026-10-16.md.

import { generateKeyPairSync, randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { verifyProjectHostAuthToken } from "@cocalc/conat/auth/project-host-token";

const keys = generateKeyPairSync("ed25519");
const PRIVATE_KEY = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const PUBLIC_KEY = keys.publicKey.export({ type: "spki", format: "pem" });
const HOST_ID = "00000000-1000-4000-8000-000000000099";

const settings = { computers_enabled: true };
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => settings,
}));
jest.mock("@cocalc/database/settings/site-url", () => ({
  __esModule: true,
  default: async () => "https://cocalc.ai",
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  ...jest.requireActual("@cocalc/server/cluster-config"),
  isMultiBayCluster: () => false,
}));
jest.mock("@cocalc/backend/data", () => ({
  ...jest.requireActual("@cocalc/backend/data"),
  getProjectHostAuthTokenPrivateKey: () => PRIVATE_KEY,
}));
let mockHost: any = { connect_url: "https://host-1.example.com" };
jest.mock("@cocalc/server/conat/api/hosts", () => ({
  resolveHostConnectionLocal: async () => mockHost,
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveHostBay: async () => null,
}));
const mockSync = jest.fn(async () => {});
jest.mock("@cocalc/server/project-host/control", () => ({
  syncProjectUsersOnHost: (opts) => mockSync(opts),
}));
const mockDrop = jest.fn(async () => {});
jest.mock("@cocalc/server/project-host/client", () => ({
  getRoutedHostControlClient: async () => ({
    dropComputer: (opts) => mockDrop(opts),
  }),
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const tables = [
  "paired_computers",
  "computer_pairing_requests",
  "projects",
  "accounts",
];

describeDb("computers at the home bay", () => {
  const db = () => getPool();
  const account = randomUUID();
  const other = randomUUID();
  const project = randomUUID();
  const machine = {
    hostname: "studio",
    os: "darwin",
    arch: "arm64",
    user: "sage",
  };
  let address = 0;
  // A fresh address per call: the per-address limits are tested on their own.
  const from = () => `10.0.0.${++address}`;

  beforeAll(async () => {
    await syncSchema(Object.fromEntries(tables.map((t) => [t, SCHEMA[t]])));
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    settings.computers_enabled = true;
    mockHost = { connect_url: "https://host-1.example.com" };
    for (const t of tables) await db().query(`DELETE FROM ${t}`);
    await db().query(
      "INSERT INTO accounts (account_id, email_address, first_name, created) VALUES ($1,'ada@example.org','Ada',now())",
      [account],
    );
    await db().query(
      "INSERT INTO accounts (account_id, email_address, created) VALUES ($1,'bob@example.org',now())",
      [other],
    );
    await db().query(
      "INSERT INTO projects (project_id, users, host_id) VALUES ($1,$2,$3)",
      [project, { [account]: { group: "owner" } }, HOST_ID],
    );
    const { resetPairingRateLimitForTesting } = await import("./pairing-http");
    resetPairingRateLimitForTesting();
  });

  async function pair(name = "m1") {
    const { createComputerRequest, approveComputerRequest } =
      await import("./requests");
    const http = await import("./pairing-http");
    const { request_id } = await createComputerRequest({
      account_id: account,
      name,
      project_id: project,
    });
    const view: any = await http.pairingView({ request_id }, from());
    expect(view).toMatchObject({ name, state: "pending" });
    expect(view.account_label).toBe("Ada <a***@e***.org>");
    const claim: any = await http.pairingClaim({ request_id, machine }, from());
    expect(claim.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(claim.pairing_phrase).toMatch(/^[a-z]+(-[a-z]+){3}$/);
    const { computer_id } = await approveComputerRequest({
      account_id: account,
      request_id,
      pairing_phrase: claim.pairing_phrase,
    });
    return { request_id, computer_id, token: claim.secret, claim };
  }

  it("pairs: request, claim, phrase, approval; the machine learns its id with its secret", async () => {
    const http = await import("./pairing-http");
    const { request_id, computer_id, token } = await pair();
    // Only the claimant, with its secret, sees the outcome.
    expect(
      await http.pairingStatus({ request_id, secret: "x".repeat(43) }, from()),
    ).toEqual({ error: "no such pairing" });
    expect(
      await http.pairingStatus({ request_id, secret: token }, from()),
    ).toMatchObject({
      state: "approved",
      computer_id,
      project_id: project,
      name: "m1",
    });
    // The token is stored only as its hash.
    const { rows } = await db().query(
      "SELECT token_hash, hostname, project_id FROM paired_computers WHERE computer_id=$1",
      [computer_id],
    );
    expect(rows[0].token_hash).not.toContain(token);
    expect(rows[0]).toMatchObject({ hostname: "studio", project_id: project });
    const { listComputers } = await import("./computers");
    expect(await listComputers(account)).toMatchObject([
      { computer_id, name: "m1", project_id: project, online: false },
    ]);
  });

  it("serves only a project whose one collaborator is the owner, at this bay", async () => {
    const { createComputerRequest } = await import("./requests");
    await db().query("UPDATE projects SET users=$2 WHERE project_id=$1", [
      project,
      { [account]: { group: "owner" }, [other]: { group: "collaborator" } },
    ]);
    await expect(
      createComputerRequest({
        account_id: account,
        name: "m1",
        project_id: project,
      }),
    ).rejects.toThrow("one collaborator is you");
    await db().query("UPDATE projects SET users=$2 WHERE project_id=$1", [
      project,
      { [other]: { group: "owner" } },
    ]);
    await expect(
      createComputerRequest({
        account_id: account,
        name: "m1",
        project_id: project,
      }),
    ).rejects.toThrow("one collaborator is you");
    await db().query(
      "UPDATE projects SET users=$2, owning_bay_id='another-bay' WHERE project_id=$1",
      [project, { [account]: { group: "owner" } }],
    );
    await expect(
      createComputerRequest({
        account_id: account,
        name: "m1",
        project_id: project,
      }),
    ).rejects.toThrow("no such project here");
  });

  it("a second claim invalidates the request; approval needs the machine's exact phrase", async () => {
    const { createComputerRequest, approveComputerRequest } =
      await import("./requests");
    const http = await import("./pairing-http");
    const { request_id } = await createComputerRequest({
      account_id: account,
      name: "m1",
      project_id: project,
    });
    // Not claimed yet: nothing to approve.
    await expect(
      approveComputerRequest({
        account_id: account,
        request_id,
        pairing_phrase: "a-b-c-d",
      }),
    ).rejects.toThrow("no machine has claimed");
    const claim: any = await http.pairingClaim({ request_id, machine }, from());
    await expect(
      approveComputerRequest({
        account_id: account,
        request_id,
        pairing_phrase: "acorn-acorn-acorn-acorn",
      }),
    ).rejects.toThrow("doesn't match");
    // Someone else's account can't approve it either.
    await expect(
      approveComputerRequest({
        account_id: other,
        request_id,
        pairing_phrase: claim.pairing_phrase,
      }),
    ).rejects.toThrow("no such computer request");
    expect(await http.pairingClaim({ request_id, machine }, from())).toEqual({
      error: expect.stringContaining("no longer valid"),
    });
    await expect(
      approveComputerRequest({
        account_id: account,
        request_id,
        pairing_phrase: claim.pairing_phrase,
      }),
    ).rejects.toThrow("invalidated");
  });

  it("gives a paired computer its project's host and a host token for exactly that", async () => {
    const http = await import("./pairing-http");
    const { computer_id, token } = await pair();
    const answer: any = await http.computerConnect(
      { computer_id, token },
      from(),
    );
    expect(answer).toMatchObject({
      computer_id,
      project_id: project,
      host_id: HOST_ID,
      address: "https://host-1.example.com",
    });
    // Never pushes the collaborators to the host: an older copy could
    // overwrite a newer one there (the host keeps its own current).
    expect(mockSync).not.toHaveBeenCalled();
    expect(
      verifyProjectHostAuthToken({
        token: answer.token,
        host_id: HOST_ID,
        public_key: PUBLIC_KEY,
      }),
    ).toMatchObject({
      act: "computer",
      sub: computer_id,
      computer: { account_id: account, project_id: project },
    });
    const { listComputers } = await import("./computers");
    expect((await listComputers(account))[0].online).toBe(true);
    // A wrong token, or another computer's id, gets nothing.
    expect(
      await http.computerConnect(
        { computer_id, token: "y".repeat(43) },
        from(),
      ),
    ).toEqual({ error: "no such computer" });
    expect(
      await http.computerConnect({ computer_id: randomUUID(), token }, from()),
    ).toEqual({ error: "no such computer" });
  });

  it("refuses a host token while computers are off, the project gained a collaborator, or has no reachable host", async () => {
    const http = await import("./pairing-http");
    const { computer_id, token } = await pair();
    settings.computers_enabled = false;
    expect(
      await http.computerConnect({ computer_id, token }, from()),
    ).toMatchObject({
      error: expect.stringContaining("turned off"),
    });
    settings.computers_enabled = true;
    await db().query("UPDATE projects SET users=$2 WHERE project_id=$1", [
      project,
      { [account]: { group: "owner" }, [other]: { group: "collaborator" } },
    ]);
    expect(
      await http.computerConnect({ computer_id, token }, from()),
    ).toMatchObject({
      error: expect.stringContaining("one collaborator is you"),
    });
    await db().query(
      "UPDATE projects SET users=$2, host_id=NULL WHERE project_id=$1",
      [project, { [account]: { group: "owner" } }],
    );
    expect(
      await http.computerConnect({ computer_id, token }, from()),
    ).toMatchObject({
      transient: true,
    });
    await db().query("UPDATE projects SET host_id=$2 WHERE project_id=$1", [
      project,
      HOST_ID,
    ]);
    mockHost = { local_proxy: true };
    expect(
      await http.computerConnect({ computer_id, token }, from()),
    ).toMatchObject({
      transient: true,
    });
  });

  it("revoked: the host is told, and the computer hears it ended for good", async () => {
    const http = await import("./pairing-http");
    const { revokeComputer, listComputers } = await import("./computers");
    const { computer_id, token } = await pair();
    await expect(
      revokeComputer({ account_id: other, computer_id }),
    ).rejects.toThrow("no such computer");
    await revokeComputer({ account_id: account, computer_id });
    expect(mockDrop).toHaveBeenCalledWith({ computer_id });
    expect(await http.computerConnect({ computer_id, token }, from())).toEqual({
      error: "this computer was revoked in CoCalc",
      revoked: true,
    });
    expect((await listComputers(account))[0].revoked_at).not.toBeNull();
    // Its name is free again.
    await pair("m1");
  });

  it("tells each host the switch and its projects' recent revocations", async () => {
    const { revokeComputer, computerAccessForHost } =
      await import("./computers");
    const { computer_id } = await pair();
    expect(await computerAccessForHost(HOST_ID)).toEqual({
      enabled: true,
      revoked: [],
    });
    await revokeComputer({ account_id: account, computer_id });
    expect(await computerAccessForHost(HOST_ID)).toEqual({
      enabled: true,
      revoked: [computer_id],
    });
    // Another host hears nothing about it.
    expect(
      (await computerAccessForHost("00000000-1000-4000-8000-000000000098"))
        .revoked,
    ).toEqual([]);
    // Long enough ago that no token issued before is valid: forgotten.
    await db().query(
      "UPDATE paired_computers SET revoked_at=now() - interval '1 hour'",
    );
    expect((await computerAccessForHost(HOST_ID)).revoked).toEqual([]);
    settings.computers_enabled = false;
    expect((await computerAccessForHost(HOST_ID)).enabled).toBe(false);
  });

  it("deleting the account revokes its computers", async () => {
    const { revokeComputersForAccount, dropOnHosts } =
      await import("./computers");
    const { computer_id } = await pair();
    const revoked = await revokeComputersForAccount(db(), account);
    expect(revoked).toEqual([{ computer_id, project_id: project }]);
    await dropOnHosts(revoked);
    expect(mockDrop).toHaveBeenCalledWith({ computer_id });
  });

  it("limits each address: claims more tightly than reads", async () => {
    const http = await import("./pairing-http");
    const results: any[] = [];
    for (let i = 0; i < 12; i++) {
      results.push(
        await http.pairingClaim(
          { request_id: "R-0000000000", machine },
          "10.9.9.9",
        ),
      );
    }
    expect(results.slice(0, 10).every((r) => /no such/.test(r.error))).toBe(
      true,
    );
    expect(results[11]).toMatchObject({
      error: expect.stringContaining("too many requests"),
      transient: true,
    });
  });
});
