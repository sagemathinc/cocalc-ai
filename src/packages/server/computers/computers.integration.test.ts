/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The computers store against real SQL (in-memory PGlite, tables created from
// db-schema). Run with COCALC_TEST_USE_PGLITE=1.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import {
  parseComputerPolicy,
  type ComputerPolicy,
} from "@cocalc/util/computers/policy";
import {
  parsePairingTranscript,
  SIGNED_KINDS,
} from "@cocalc/util/computers/protocol";
import {
  generateAgreementKey,
  generateSigningKey,
  policyHash,
  randomNonce,
  signEnvelope,
  verifyEnvelope,
  type KeyPair,
} from "@cocalc/backend/computers/crypto";

jest.mock("@cocalc/database/settings/secret-settings", () => ({
  encryptSecretStorageValue: async (name: string, value: string) =>
    `test-enc:${name}:${Buffer.from(value).toString("base64")}`,
  decryptSecretStorageValue: async (name: string, value: string) => {
    const prefix = `test-enc:${name}:`;
    if (!value.startsWith(prefix)) throw new Error("wrong associated data");
    return {
      value: Buffer.from(value.slice(prefix.length), "base64").toString(),
      needsMigration: false,
    };
  },
}));
jest.mock("@cocalc/database/settings/site-url", () => ({
  __esModule: true,
  default: async () => "https://cocalc.ai",
}));

let multiBay = false;
jest.mock("@cocalc/server/cluster-config", () => ({
  ...jest.requireActual("@cocalc/server/cluster-config"),
  isMultiBayCluster: () => multiBay,
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const tables = [
  "account_computers",
  "account_computer_requests",
  "account_computer_operations",
  "account_computer_jobs",
  "cluster_computer_signing_keys",
  "bay_computer_signing_keys",
  "agent_personal_controls",
  "agent_networks",
  "agent_network_members",
  "projects",
  "public_project_paths",
  "accounts",
];

describeDb("computers store", () => {
  const db = () => getPool();
  const account = randomUUID();
  const network = randomUUID();

  async function networkGeneration(): Promise<string> {
    const { rows } = await getPool().query(
      "SELECT generation FROM agent_networks WHERE agent_network_id=$1",
      [network],
    );
    return rows[0].generation;
  }

  beforeAll(async () => {
    await syncSchema(Object.fromEntries(tables.map((t) => [t, SCHEMA[t]])));
  });

  beforeEach(async () => {
    for (const t of tables.slice().reverse())
      await db().query(`DELETE FROM ${t}`);
    const { resetSigningKeyCacheForTesting } = await import("./signing-keys");
    resetSigningKeyCacheForTesting();
    await db().query(
      "INSERT INTO accounts (account_id, email_address, created) VALUES ($1,'a@example.org',now())",
      [account],
    );
    await db().query(
      `INSERT INTO agent_networks
         (agent_network_id, account_id, title, state, delivery_mode, generation, created_by)
       VALUES ($1,$2,'lab','active','queued',$3,$2)`,
      [network, account, randomUUID()],
    );
  });

  async function trusted() {
    const { trustedSigningKeys } = await import("./signing-keys");
    const keys = await trustedSigningKeys();
    return (kid: string) => keys.get(kid);
  }

  describe("signing keys", () => {
    it("creates one key, reuses it, and publishes it in the directory", async () => {
      const {
        getBaySigningKey,
        listSigningKeyDirectory,
        resetSigningKeyCacheForTesting,
      } = await import("./signing-keys");
      const first = await getBaySigningKey();
      resetSigningKeyCacheForTesting();
      const again = await getBaySigningKey();
      expect(again.fingerprint).toBe(first.fingerprint);
      const directory = await listSigningKeyDirectory();
      expect(directory.map((k) => k.kid)).toEqual([first.fingerprint]);
      expect(directory[0].bay_id).toBe("bay-0");
      // The private key is stored encrypted, bound to its kid.
      const { rows } = await db().query(
        "SELECT * FROM bay_computer_signing_keys",
      );
      expect(rows[0].encrypted_private_key).toMatch(
        /^test-enc:computer-signing-key:sha256:/,
      );
      expect(rows[0].encrypted_private_key).not.toContain("PRIVATE KEY");
    });

    it("refuses a stored key that doesn't match its kid", async () => {
      const { getBaySigningKey, resetSigningKeyCacheForTesting } =
        await import("./signing-keys");
      const key = await getBaySigningKey();
      const other = generateSigningKey();
      const { privateKeyToPem } =
        await import("@cocalc/backend/computers/crypto");
      await db().query(
        "UPDATE bay_computer_signing_keys SET encrypted_private_key=$1",
        [
          `test-enc:computer-signing-key:${key.fingerprint}:${Buffer.from(privateKeyToPem(other.privateKey)).toString("base64")}`,
        ],
      );
      resetSigningKeyCacheForTesting();
      await expect(getBaySigningKey()).rejects.toThrow(/does not match/);
    });
  });

  describe("project attestations", () => {
    async function project(users: Record<string, unknown>, revision = 7) {
      const project_id = randomUUID();
      await db().query(
        `INSERT INTO projects (project_id, users, runtime_authority_revision) VALUES ($1,$2,$3)`,
        [project_id, JSON.stringify(users), revision],
      );
      return project_id;
    }

    it("attests an owner-only project as eligible, signed and short-lived", async () => {
      const { attestProjectLocal } = await import("./attestation");
      const project_id = await project({ [account]: { group: "owner" } });
      const now = Date.UTC(2026, 9, 11, 12);
      const env = await attestProjectLocal({
        project_id,
        account_id: account,
        home_bay_id: "bay-0",
        now,
      });
      expect(env.payload).toMatchObject({
        eligible: true,
        privacy_epoch: 7,
        project_id,
        account_id: account,
        project_bay_id: "bay-0",
        site: "https://cocalc.ai",
        cluster_id: "standalone",
      });
      expect(env.payload.not_after - env.payload.issued_at).toBe(30_000);
      expect(
        verifyEnvelope(SIGNED_KINDS.attestation, env, await trusted()),
      ).toBe(true);
    });

    it.each([
      ["a collaborator", { group: "collaborator" }],
      ["a viewer", { group: "viewer" }],
      ["a second owner", { group: "owner" }],
    ])("is not eligible with %s", async (_label, other) => {
      const { attestProjectLocal } = await import("./attestation");
      const project_id = await project({
        [account]: { group: "owner" },
        [randomUUID()]: other,
      });
      const env = await attestProjectLocal({
        project_id,
        account_id: account,
        home_bay_id: "bay-0",
      });
      expect(env.payload.eligible).toBe(false);
    });

    it("explains why a project can't use computers, one reason at a time", async () => {
      const { explainProjectIneligibility } = await import("./attestation");
      const explain = (project_id: string) =>
        explainProjectIneligibility({ project_id, account_id: account });
      const mine = await project({ [account]: { group: "owner" } });
      expect(await explain(mine)).toBeNull();
      // A public share doesn't matter.
      await db().query(
        "INSERT INTO public_project_paths (id, project_id, path, visibility, disabled) VALUES ($1,$2,'pub','listed',false)",
        [randomUUID(), mine],
      );
      expect(await explain(mine)).toBeNull();
      const shared = await project({
        [account]: { group: "owner" },
        [randomUUID()]: { group: "collaborator" },
      });
      expect(await explain(shared)).toMatch(/only collaborator is you/);
      await db().query("UPDATE projects SET deleted=true WHERE project_id=$1", [
        mine,
      ]);
      expect(await explain(mine)).toMatch(/deleted/);
      expect(await explain(randomUUID())).toBe("no such project");
    });

    it("public shares don't affect eligibility or the privacy epoch, and share changes aren't restricted", async () => {
      const { attestProjectLocal } = await import("./attestation");
      const project_id = await project({ [account]: { group: "owner" } }, 7);
      const attest = async () =>
        (
          await attestProjectLocal({
            project_id,
            account_id: account,
            home_bay_id: "bay-0",
          })
        ).payload;
      expect(await attest()).toMatchObject({
        eligible: true,
        privacy_epoch: 7,
      });
      const share = randomUUID();
      await db().query(
        "INSERT INTO public_project_paths (id, project_id, path, visibility, disabled) VALUES ($1,$2,'pub','listed',false)",
        [share, project_id],
      );
      expect(await attest()).toMatchObject({
        eligible: true,
        privacy_epoch: 7,
      });
      // Even on a bay that doesn't own the project (no trigger refuses it).
      await db().query(
        "UPDATE projects SET owning_bay_id='bay-9' WHERE project_id=$1",
        [project_id],
      );
      await db().query(
        "UPDATE public_project_paths SET disabled=false, visibility='unlisted' WHERE id=$1",
        [share],
      );
      await db().query("DELETE FROM public_project_paths WHERE id=$1", [share]);
    });

    it("retires the public-share trigger a development build installed", async () => {
      const {
        projectComputersPrivacySchemaNeedsSync,
        retireProjectComputersPrivacySchema,
      } =
        await import("@cocalc/database/postgres/schema/project-computers-privacy");
      const client = await db().connect();
      try {
        await client.query(
          "CREATE TABLE IF NOT EXISTS computers_local_bay (singleton BOOLEAN PRIMARY KEY DEFAULT true, bay_id TEXT NOT NULL)",
        );
        await client.query(`CREATE OR REPLACE FUNCTION public_project_paths_bump_computers_privacy()
          RETURNS TRIGGER AS $$ BEGIN RAISE EXCEPTION 'retired trigger still runs'; END; $$ LANGUAGE plpgsql`);
        await client.query(`CREATE TRIGGER public_project_paths_bump_computers_privacy_trigger
          AFTER INSERT OR UPDATE OR DELETE ON public_project_paths
          FOR EACH ROW EXECUTE FUNCTION public_project_paths_bump_computers_privacy()`);
        expect(await projectComputersPrivacySchemaNeedsSync(client)).toBe(true);
        await retireProjectComputersPrivacySchema(client);
        expect(await projectComputersPrivacySchemaNeedsSync(client)).toBe(
          false,
        );
        // Share changes work again.
        const project_id = await project({ [account]: { group: "owner" } });
        await client.query(
          "INSERT INTO public_project_paths (id, project_id, path, visibility, disabled) VALUES ($1,$2,'x','listed',false)",
          [randomUUID(), project_id],
        );
      } finally {
        client.release();
      }
    });

    it("only the owning bay attests, and never while the project is being rehomed", async () => {
      const { attestProjectLocal } = await import("./attestation");
      const project_id = await project({ [account]: { group: "owner" } });
      const attest = () =>
        attestProjectLocal({
          project_id,
          account_id: account,
          home_bay_id: "bay-0",
        });
      await db().query(
        "UPDATE projects SET owning_bay_id='bay-3' WHERE project_id=$1",
        [project_id],
      );
      await expect(attest()).rejects.toThrow(/no longer owns the project/);
      await db().query(
        "UPDATE projects SET owning_bay_id='bay-0' WHERE project_id=$1",
        [project_id],
      );
      await db().query(
        `CREATE TABLE IF NOT EXISTS project_rehome_operations
           (op_id TEXT, project_id UUID, source_bay_id TEXT, dest_bay_id TEXT,
            stage TEXT, status TEXT, created_at TIMESTAMPTZ DEFAULT now())`,
      );
      try {
        await db().query(
          "INSERT INTO project_rehome_operations VALUES ('p1',$1,'bay-0','bay-3','requested','running',now())",
          [project_id],
        );
        await expect(attest()).rejects.toThrow(/project rehome p1 is running/);
      } finally {
        await db().query("DROP TABLE project_rehome_operations");
      }
      await expect(attest()).resolves.toHaveProperty("payload.eligible", true);
    });

    it("is not eligible for an account that isn't the owner", async () => {
      const { attestProjectLocal } = await import("./attestation");
      const project_id = await project({ [account]: { group: "owner" } });
      const env = await attestProjectLocal({
        project_id,
        account_id: randomUUID(),
        home_bay_id: "bay-0",
      });
      expect(env.payload.eligible).toBe(false);
    });
  });

  describe("requests, pairing and approval", () => {
    const requested = {
      version: 1,
      mode: "isolated",
      duration: { initial_seconds: 3600, max_seconds: 8 * 3600 },
      agent_network_id: network,
      network: "on",
      gpu: false,
      mounts: [{ path: "~/datasets", access: "ro" }],
      images: { kind: "any" },
      scratch_bytes: null,
      limits: { cpu_millis: null, memory_bytes: null, pids: null },
    };
    const resolvedFor = (
      overrides: Partial<ComputerPolicy> = {},
    ): ComputerPolicy =>
      parseComputerPolicy({
        ...requested,
        mounts: [
          {
            path: "/Users/w/datasets",
            access: "ro",
            device: "16777230",
            inode: "42",
          },
        ],
        ...overrides,
      });

    async function machinePairs(
      request_id: string,
      {
        signing = generateSigningKey(),
        agreement = generateAgreementKey(),
        resolved = resolvedFor(),
        nonce,
      }: {
        signing?: KeyPair;
        agreement?: KeyPair;
        resolved?: ComputerPolicy;
        nonce?: string;
      } = {},
    ) {
      const { getPairingView, submitPairing } = await import("./requests");
      const view = await getPairingView(request_id);
      const transcript = parsePairingTranscript({
        type: "cocalc-computer-pairing",
        version: 1,
        site: view.site,
        cluster_id: view.cluster_id,
        request_id,
        account_id: view.account_id,
        policy_hash: policyHash(resolved),
        signing_key: signing.fingerprint,
        agreement_key: agreement.fingerprint,
        client_nonce: randomNonce(),
        server_nonce: nonce ?? view.server_nonce,
        machine: {
          hostname: "macbook",
          os: "darwin",
          arch: "arm64",
          user: "w",
        },
      });
      const args = {
        request_id,
        transcript: signEnvelope(SIGNED_KINDS.transcript, transcript, signing),
        signing_public_key: signing.publicDer,
        resolved_policy: resolved,
      };
      const result = await submitPairing(args);
      return { ...result, signing, transcript, args };
    }

    async function newRequest(name = "laptop") {
      const { createComputerRequest } = await import("./requests");
      return await createComputerRequest({
        account_id: account,
        name,
        requested_policy: requested,
        why: "check the build",
      });
    }

    it("pairs and approves: one computer, a certificate the daemon can verify", async () => {
      const { approveComputerRequest } = await import("./requests");
      const { request_id } = await newRequest();
      expect(request_id).toMatch(/^R-[0-9A-HJ-NP-Z]{10}$/);
      const paired = await machinePairs(request_id);
      expect(paired.pairing_phrase).toMatch(/^[a-z]+(-[a-z]+){3}$/);
      const approved = await approveComputerRequest({
        agent_network_generation: await networkGeneration(),
        account_id: account,
        request_id,
        transcript_hash: paired.transcript_hash,
      });
      const cert = approved.certificate.payload;
      expect(cert).toMatchObject({
        computer_id: approved.computer_id,
        account_id: account,
        signing_key: paired.signing.fingerprint,
        agreement_key: paired.transcript.agreement_key,
        transcript_hash: paired.transcript_hash,
        ceiling_hash: policyHash(resolvedFor()),
      });
      expect(
        verifyEnvelope(
          SIGNED_KINDS.certificate,
          approved.certificate,
          await trusted(),
        ),
      ).toBe(true);
      const { listComputers } = await import("./computers");
      const [computer] = await listComputers(account);
      expect(computer).toMatchObject({
        name: "laptop",
        mode: "isolated",
        epoch: 1,
        policy_epoch: 0,
      });
      expect(computer.effective_policy.mounts[0].path).toBe(
        "/Users/w/datasets",
      );
      expect(computer.max_deadline! - computer.deadline!).toBe(7 * 3600 * 1000);
    });

    it("the same claim sent again (a lost answer) is answered again, not invalidated", async () => {
      const { submitPairing } = await import("./requests");
      const { request_id } = await newRequest();
      const first = await machinePairs(request_id);
      expect(await submitPairing(first.args)).toEqual({
        pairing_phrase: first.pairing_phrase,
        transcript_hash: first.transcript_hash,
      });
      const { rows } = await db().query(
        "SELECT state FROM account_computer_requests WHERE request_id=$1",
        [request_id],
      );
      expect(rows[0].state).toBe("paired");
    });

    it("refuses control characters and bidi overrides in what the owner reads", async () => {
      const { createComputerRequest } = await import("./requests");
      for (const why of ["\u001b[2Jclear", "rm \u202eexe.txt", "a\u0007b"]) {
        await expect(
          createComputerRequest({
            account_id: account,
            name: "x",
            requested_policy: requested,
            why,
          }),
        ).rejects.toThrow(/control characters/);
      }
      await expect(
        createComputerRequest({
          account_id: account,
          name: "x",
          requested_policy: {
            ...requested,
            mounts: [{ path: "~/data\u202e", access: "ro" }],
          },
        }),
      ).rejects.toThrow(/not a valid path/);
      // Newlines and tabs in the reason are fine.
      await expect(
        createComputerRequest({
          account_id: account,
          name: "x",
          requested_policy: requested,
          why: "line one\n\tline two",
        }),
      ).resolves.toHaveProperty("request_id");
    });

    it("a second claimant invalidates the request and never replaces the first key", async () => {
      const { approveComputerRequest } = await import("./requests");
      const { request_id } = await newRequest();
      const first = await machinePairs(request_id);
      await expect(machinePairs(request_id)).rejects.toThrow(
        /another computer already claimed/,
      );
      const { rows } = await db().query(
        "SELECT state, claimants FROM account_computer_requests WHERE request_id=$1",
        [request_id],
      );
      expect(rows[0].state).toBe("invalidated");
      expect(Number(rows[0].claimants)).toBe(2); // BIGINT comes back as a string
      await expect(
        approveComputerRequest({
          agent_network_generation: await networkGeneration(),
          account_id: account,
          request_id,
          transcript_hash: first.transcript_hash,
        }),
      ).rejects.toThrow(/invalidated/);
    });

    it("refuses a transcript with the wrong nonce, a widened policy, or another signer", async () => {
      const { submitPairing } = await import("./requests");
      const a = await newRequest("a");
      await expect(
        machinePairs(a.request_id, { nonce: randomNonce() }),
      ).rejects.toThrow(/does not match this request/);
      const b = await newRequest("b");
      await expect(
        machinePairs(b.request_id, { resolved: resolvedFor({ gpu: true }) }),
      ).rejects.toThrow(/gpu differs/);
      const c = await newRequest("c");
      const signer = generateSigningKey();
      const resolved = resolvedFor();
      const { getPairingView } = await import("./requests");
      const view = await getPairingView(c.request_id);
      const transcript = {
        type: "cocalc-computer-pairing",
        version: 1,
        site: view.site,
        cluster_id: view.cluster_id,
        request_id: c.request_id,
        account_id: account,
        policy_hash: policyHash(resolved),
        signing_key: signer.fingerprint,
        agreement_key: generateAgreementKey().fingerprint,
        client_nonce: randomNonce(),
        server_nonce: view.server_nonce,
        machine: { hostname: "h", os: "linux", arch: "x64", user: "u" },
      };
      await expect(
        submitPairing({
          request_id: c.request_id,
          transcript: signEnvelope(
            SIGNED_KINDS.transcript,
            transcript,
            generateSigningKey(),
          ),
          signing_public_key: signer.publicDer,
          resolved_policy: resolved,
        }),
      ).rejects.toThrow(/not signed by the key it names/);
    });

    it("refuses approval of a changed transcript, by another account, or after expiry", async () => {
      const stranger = randomUUID();
      await db().query(
        "INSERT INTO accounts (account_id, email_address, created) VALUES ($1,'s@example.org',now())",
        [stranger],
      );
      const { approveComputerRequest } = await import("./requests");
      const { request_id } = await newRequest();
      const paired = await machinePairs(request_id);
      await expect(
        approveComputerRequest({
          agent_network_generation: await networkGeneration(),
          account_id: account,
          request_id,
          transcript_hash: "sha256:" + "x".repeat(43),
        }),
      ).rejects.toThrow(/changed since you saw it/);
      await expect(
        approveComputerRequest({
          agent_network_generation: await networkGeneration(),
          account_id: stranger,
          request_id,
          transcript_hash: paired.transcript_hash,
        }),
      ).rejects.toThrow(/no such computer request/);
      await expect(
        approveComputerRequest({
          agent_network_generation: await networkGeneration(),
          account_id: account,
          request_id,
          transcript_hash: paired.transcript_hash,
          now: Date.now() + 16 * 60 * 1000,
        }),
      ).rejects.toThrow(/expired/);
    });

    it("refuses a request for a network that isn't the account's, and a taken name", async () => {
      const { createComputerRequest, approveComputerRequest } =
        await import("./requests");
      await expect(
        createComputerRequest({
          account_id: account,
          name: "x",
          requested_policy: { ...requested, agent_network_id: randomUUID() },
        }),
      ).rejects.toThrow(/agent network/);
      const one = await newRequest("dup");
      const p1 = await machinePairs(one.request_id);
      await approveComputerRequest({
        agent_network_generation: await networkGeneration(),
        account_id: account,
        request_id: one.request_id,
        transcript_hash: p1.transcript_hash,
      });
      const two = await newRequest("dup");
      const p2 = await machinePairs(two.request_id);
      await expect(
        approveComputerRequest({
          agent_network_generation: await networkGeneration(),
          account_id: account,
          request_id: two.request_id,
          transcript_hash: p2.transcript_hash,
        }),
      ).rejects.toThrow(/already exists/);
    });
  });

  describe("computers", () => {
    async function approvedComputer() {
      const {
        createComputerRequest,
        getPairingView,
        submitPairing,
        approveComputerRequest,
      } = await import("./requests");
      const resolved = parseComputerPolicy({
        version: 1,
        mode: "isolated",
        duration: { initial_seconds: 3600, max_seconds: 2 * 3600 },
        agent_network_id: network,
        network: "on",
        gpu: false,
        mounts: [],
        images: { kind: "allow", refs: ["ubuntu:24.04", "python:3.13"] },
        scratch_bytes: 2 ** 30,
        limits: { cpu_millis: 4000, memory_bytes: 2 ** 32, pids: 1000 },
      });
      const { request_id } = await createComputerRequest({
        account_id: account,
        name: "box",
        requested_policy: resolved,
      });
      const view = await getPairingView(request_id);
      const signing = generateSigningKey();
      const transcript = {
        type: "cocalc-computer-pairing",
        version: 1,
        site: view.site,
        cluster_id: view.cluster_id,
        request_id,
        account_id: account,
        policy_hash: policyHash(resolved),
        signing_key: signing.fingerprint,
        agreement_key: generateAgreementKey().fingerprint,
        client_nonce: randomNonce(),
        server_nonce: view.server_nonce,
        machine: { hostname: "box", os: "linux", arch: "x64", user: "u" },
      };
      const { transcript_hash } = await submitPairing({
        request_id,
        transcript: signEnvelope(SIGNED_KINDS.transcript, transcript, signing),
        signing_public_key: signing.publicDer,
        resolved_policy: resolved,
      });
      return {
        ...(await approveComputerRequest({
          agent_network_generation: await networkGeneration(),
          account_id: account,
          request_id,
          transcript_hash,
        })),
        resolved,
      };
    }

    it("revoking bumps the epoch once", async () => {
      const { revokeComputer, getComputer } = await import("./computers");
      const { computer_id } = await approvedComputer();
      expect(
        (await revokeComputer({ account_id: account, computer_id })).epoch,
      ).toBe(2);
      expect(
        (await revokeComputer({ account_id: account, computer_id })).epoch,
      ).toBe(2);
      expect(
        (await getComputer(account, computer_id)).revoked_at,
      ).not.toBeNull();
    });

    it("narrows the effective policy but never widens it", async () => {
      const { setEffectivePolicy } = await import("./computers");
      const { computer_id, resolved } = await approvedComputer();
      const narrower = {
        ...resolved,
        network: "off",
        images: { kind: "allow", refs: ["ubuntu:24.04"] },
      };
      expect(
        (
          await setEffectivePolicy({
            account_id: account,
            computer_id,
            policy: narrower,
          })
        ).policy_epoch,
      ).toBe(1);
      await expect(
        setEffectivePolicy({
          account_id: account,
          computer_id,
          policy: { ...resolved, gpu: true },
        }),
      ).rejects.toThrow(/widen.*GPU/);
      await expect(
        setEffectivePolicy({
          account_id: account,
          computer_id,
          policy: { ...resolved, images: { kind: "any" } },
        }),
      ).rejects.toThrow(/image/);
    });

    it("extends within the maximum only", async () => {
      const { extendComputer, getComputer } = await import("./computers");
      const { computer_id } = await approvedComputer();
      const before = await getComputer(account, computer_id);
      const { deadline } = await extendComputer({
        account_id: account,
        computer_id,
        seconds: 10 * 3600,
      });
      expect(deadline).toBe(before.max_deadline);
    });

    it("notes: compare-and-swap, attribution, owner lock", async () => {
      const { setComputerNotes, getComputer } = await import("./computers");
      const { computer_id } = await approvedComputer();
      const agent = {
        kind: "agent" as const,
        agent_id: randomUUID(),
        project_id: randomUUID(),
      };
      const owner = { kind: "owner" as const, account_id: account };
      // Not a member of the computer's network yet: refused.
      await expect(
        setComputerNotes({
          account_id: account,
          computer_id,
          author: agent,
          notes: "sneaky",
          expected_revision: 0,
        }),
      ).rejects.toThrow(/no such computer for this agent/);
      await db().query(
        `INSERT INTO agent_network_members
           (agent_network_id, member_kind, member_id, registered_agent_id, project_id, added_by)
         VALUES ($1,'registered',$2,$2,$3,$4)`,
        [network, agent.agent_id, agent.project_id, account],
      );
      await setComputerNotes({
        account_id: account,
        computer_id,
        author: agent,
        notes: "datasets in /data",
        expected_revision: 0,
      });
      await expect(
        setComputerNotes({
          account_id: account,
          computer_id,
          author: agent,
          notes: "stale",
          expected_revision: 0,
        }),
      ).rejects.toThrow(/changed/);
      await expect(
        setComputerNotes({
          account_id: account,
          computer_id,
          author: agent,
          notes: "x",
          expected_revision: 1,
          locked: true,
        }),
      ).rejects.toThrow(/only the owner/);
      await setComputerNotes({
        account_id: account,
        computer_id,
        author: owner,
        notes: "benchmarks need --exclusive",
        expected_revision: 1,
        locked: true,
      });
      await expect(
        setComputerNotes({
          account_id: account,
          computer_id,
          author: agent,
          notes: "x",
          expected_revision: 2,
        }),
      ).rejects.toThrow(/locked/);
      // Removed from the network, or messaging paused: refused, in the same
      // transaction as the write.
      await db().query("UPDATE account_computers SET notes_locked=false");
      await db().query("UPDATE agent_network_members SET removed_at=now()");
      await expect(
        setComputerNotes({
          account_id: account,
          computer_id,
          author: agent,
          notes: "x",
          expected_revision: 2,
        }),
      ).rejects.toThrow(/no such computer for this agent/);
      await db().query("UPDATE agent_network_members SET removed_at=NULL");
      await db().query(
        `INSERT INTO agent_personal_controls(account_id, paused) VALUES ($1,true)
         ON CONFLICT (account_id) DO UPDATE SET paused=true`,
        [account],
      );
      await expect(
        setComputerNotes({
          account_id: account,
          computer_id,
          author: agent,
          notes: "x",
          expected_revision: 2,
        }),
      ).rejects.toThrow(/paused/);
      await db().query("UPDATE account_computers SET notes_locked=true");
      const c = await getComputer(account, computer_id);
      expect(c).toMatchObject({
        notes: "benchmarks need --exclusive",
        notes_revision: 2,
        notes_locked: true,
      });
      const { rows } = await db().query(
        "SELECT notes_history FROM account_computers WHERE computer_id=$1",
        [computer_id],
      );
      expect(rows[0].notes_history.map((h: any) => h.author.kind)).toEqual([
        "owner",
        "agent",
      ]);
      await expect(
        setComputerNotes({
          account_id: account,
          computer_id,
          author: owner,
          notes: "x".repeat(4097),
          expected_revision: 2,
        }),
      ).rejects.toThrow(/4096/);
    });

    it("narrowing the agent network bumps its computers' epochs in the caller's transaction", async () => {
      const { bumpComputersForNetwork, getComputer } =
        await import("./computers");
      const { computer_id } = await approvedComputer();
      const client = await db().connect();
      try {
        await client.query("BEGIN");
        expect(await bumpComputersForNetwork(client, account, network)).toEqual(
          [computer_id],
        );
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      expect((await getComputer(account, computer_id)).epoch).toBe(1);
    });
  });
});
