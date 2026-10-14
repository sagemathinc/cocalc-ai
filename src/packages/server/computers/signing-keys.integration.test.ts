/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Bay signing keys: rotation with endorsements, and how the seed's directory
// accepts keys that bays publish. Run with COCALC_TEST_USE_PGLITE=1.

import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import {
  parseSigningKeyEndorsement,
  SIGNED_KINDS,
} from "@cocalc/util/computers/protocol";
import type { PublishedSigningKey } from "@cocalc/util/computers/api";
import {
  generateSigningKey,
  signEnvelope,
  verifyEnvelope,
  type KeyPair,
} from "@cocalc/backend/computers/crypto";

jest.mock("@cocalc/database/settings/secret-settings", () => ({
  encryptSecretStorageValue: async (name: string, value: string) =>
    `test-enc:${name}:${Buffer.from(value).toString("base64")}`,
  decryptSecretStorageValue: async (name: string, value: string) => ({
    value: Buffer.from(
      value.slice(`test-enc:${name}:`.length),
      "base64",
    ).toString(),
    needsMigration: false,
  }),
}));

let role = "standalone";
jest.mock("@cocalc/server/cluster-config", () => ({
  ...jest.requireActual("@cocalc/server/cluster-config"),
  getConfiguredClusterRole: () => role,
}));
const seedKeys = jest.fn();
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  ...jest.requireActual("@cocalc/conat/inter-bay/api"),
  createInterBayBayRegistryClient: () => ({
    computerSigningKeys: (...args: any[]) => seedKeys(...args),
  }),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const tables = ["cluster_computer_signing_keys", "bay_computer_signing_keys"];
const DAY = 24 * 60 * 60 * 1000;

describeDb("computer signing keys", () => {
  const db = () => getPool();

  beforeAll(async () => {
    await syncSchema(Object.fromEntries(tables.map((t) => [t, SCHEMA[t]])));
  });

  beforeEach(async () => {
    for (const t of tables) await db().query(`DELETE FROM ${t}`);
    const { resetSigningKeyCacheForTesting } = await import("./signing-keys");
    resetSigningKeyCacheForTesting();
  });

  /** Another bay's key, as it would publish it. */
  function published(
    key: KeyPair,
    bay_id: string,
    endorser?: KeyPair,
    not_after = Date.now() + 300 * DAY,
  ): PublishedSigningKey {
    return {
      kid: key.fingerprint,
      public_key: key.publicDer,
      not_after,
      endorsement:
        endorser == null
          ? null
          : signEnvelope(
              SIGNED_KINDS.key_endorsement,
              parseSigningKeyEndorsement({
                type: "cocalc-computer-key-endorsement",
                version: 1,
                bay_id,
                kid: key.fingerprint,
                public_key: key.publicDer,
                not_after,
              }),
              endorser,
            ),
    };
  }

  async function directory(bay_id: string) {
    const { rows } = await db().query(
      `SELECT kid, endorsed_by FROM cluster_computer_signing_keys
        WHERE bay_id=$1 ORDER BY not_after`,
      [bay_id],
    );
    return rows;
  }

  it("rotates: the outgoing key endorses its successor, and both are published", async () => {
    const {
      getBaySigningKey,
      localPublishedSigningKeys,
      resetSigningKeyCacheForTesting,
      SIGNING_KEY_ROTATE_AFTER_MS,
    } = await import("./signing-keys");
    const first = await getBaySigningKey();
    await db().query("UPDATE bay_computer_signing_keys SET created_at=$1", [
      new Date(Date.now() - SIGNING_KEY_ROTATE_AFTER_MS - 1000),
    ]);
    resetSigningKeyCacheForTesting();
    const second = await getBaySigningKey();
    expect(second.fingerprint).not.toBe(first.fingerprint);

    const keys = await localPublishedSigningKeys();
    expect(keys.map((k) => k.kid)).toEqual([
      first.fingerprint,
      second.fingerprint,
    ]);
    expect(keys[0].endorsement).toBeNull();
    const endorsement = keys[1].endorsement!;
    expect(endorsement.kid).toBe(first.fingerprint);
    expect(endorsement.payload).toMatchObject({
      bay_id: "bay-0",
      kid: second.fingerprint,
      public_key: second.publicDer,
    });
    expect(
      verifyEnvelope(SIGNED_KINDS.key_endorsement, endorsement, (kid) =>
        kid === first.fingerprint ? first.publicKey : undefined,
      ),
    ).toBe(true);
    // A standalone bay is its own directory.
    expect(await directory("bay-0")).toEqual([
      { kid: first.fingerprint, endorsed_by: null },
      { kid: second.fingerprint, endorsed_by: first.fingerprint },
    ]);
  });

  it("accepts a bay's first key, then only keys endorsed by a trusted key of that bay", async () => {
    const { acceptDirectoryKeys } = await import("./signing-keys");
    const a = generateSigningKey();
    const b = generateSigningKey();
    const c = generateSigningKey();

    expect(await acceptDirectoryKeys("bay-7", [published(a, "bay-7")])).toEqual(
      { added: [a.fingerprint], refused: [] },
    );
    // Sending it again is a no-op, not a refusal.
    expect(await acceptDirectoryKeys("bay-7", [published(a, "bay-7")])).toEqual(
      { added: [], refused: [] },
    );
    // An unendorsed second key, or one endorsed by a stranger: refused.
    const unendorsed = await acceptDirectoryKeys("bay-7", [
      published(b, "bay-7"),
    ]);
    expect(unendorsed.refused).toEqual([
      {
        kid: b.fingerprint,
        reason: "not endorsed by a trusted key of this bay",
      },
    ]);
    const byStranger = await acceptDirectoryKeys("bay-7", [
      published(b, "bay-7", c),
    ]);
    expect(byStranger.refused[0].reason).toBe(
      "not endorsed by a trusted key of this bay",
    );
    // Endorsed by a, but for another bay or with another expiry: refused.
    const otherBay = await acceptDirectoryKeys("bay-7", [
      published(b, "bay-8", a),
    ]);
    expect(otherBay.refused[0].reason).toBe("endorsement does not match");
    const changed = published(b, "bay-7", a);
    const stretched = await acceptDirectoryKeys("bay-7", [
      { ...changed, not_after: changed.not_after + DAY },
    ]);
    expect(stretched.refused[0].reason).toBe("endorsement does not match");
    // The right payload, signed by a stranger but naming a as the endorser.
    const forged = published(b, "bay-7", c);
    const claimed = await acceptDirectoryKeys("bay-7", [
      {
        ...forged,
        endorsement: { ...forged.endorsement!, kid: a.fingerprint },
      },
    ]);
    expect(claimed.refused[0].reason).toBe("endorsement does not match");

    expect(
      await acceptDirectoryKeys("bay-7", [published(b, "bay-7", a)]),
    ).toEqual({ added: [b.fingerprint], refused: [] });
    expect(await directory("bay-7")).toEqual([
      { kid: a.fingerprint, endorsed_by: null },
      { kid: b.fingerprint, endorsed_by: a.fingerprint },
    ]);
  });

  it("only the bay's newest key may endorse a successor, and lifetimes are capped", async () => {
    const { acceptDirectoryKeys, SIGNING_KEY_LIFETIME_MS } =
      await import("./signing-keys");
    const a = generateSigningKey();
    const b = generateSigningKey();
    const c = generateSigningKey();
    await acceptDirectoryKeys("bay-5", [published(a, "bay-5")]);
    await acceptDirectoryKeys("bay-5", [published(b, "bay-5", a)]);
    // a still verifies what it signed, but b is now the newest.
    const byOld = await acceptDirectoryKeys("bay-5", [
      published(c, "bay-5", a),
    ]);
    expect(byOld.refused[0].reason).toBe(
      "not endorsed by a trusted key of this bay",
    );
    const tooLong = await acceptDirectoryKeys("bay-5", [
      published(
        c,
        "bay-5",
        b,
        Date.now() + SIGNING_KEY_LIFETIME_MS + 3_600_000,
      ),
    ]);
    expect(tooLong.refused[0].reason).toBe("key lifetime is too long");
    expect(
      (await acceptDirectoryKeys("bay-5", [published(c, "bay-5", b)])).added,
    ).toEqual([c.fingerprint]);
  });

  it("an attached bay reads the directory from the seed, not its own table", async () => {
    const { listSigningKeyDirectory, resetSigningKeyCacheForTesting } =
      await import("./signing-keys");
    const key = generateSigningKey();
    const entry = {
      kid: key.fingerprint,
      bay_id: "bay-0",
      public_key: key.publicDer,
      not_after: Date.now() + DAY,
    };
    seedKeys.mockResolvedValue([entry]);
    role = "attached";
    try {
      resetSigningKeyCacheForTesting();
      expect(await listSigningKeyDirectory()).toEqual([entry]);
      // Cached briefly: a second read doesn't ask the seed again.
      expect(await listSigningKeyDirectory()).toEqual([entry]);
      expect(seedKeys).toHaveBeenCalledTimes(1);
    } finally {
      role = "standalone";
      resetSigningKeyCacheForTesting();
    }
  });

  it("when the seed is unreachable, ticket issuance fails closed; other readers may use the last answer", async () => {
    const { listSigningKeyDirectory, resetSigningKeyCacheForTesting } =
      await import("./signing-keys");
    const key = generateSigningKey();
    const entry = {
      kid: key.fingerprint,
      bay_id: "bay-0",
      public_key: key.publicDer,
      not_after: Date.now() + DAY,
    };
    role = "attached";
    const realNow = Date.now;
    try {
      resetSigningKeyCacheForTesting();
      seedKeys.mockResolvedValueOnce([entry]);
      expect(await listSigningKeyDirectory()).toEqual([entry]);
      // Past the 30 s cache, with the seed down.
      const later = realNow() + 60_000;
      Date.now = () => later;
      seedKeys.mockRejectedValue(new Error("seed down"));
      await expect(
        listSigningKeyDirectory({ allowStale: false }),
      ).rejects.toThrow(/seed down/);
      expect(await listSigningKeyDirectory()).toEqual([entry]);
    } finally {
      Date.now = realNow;
      role = "standalone";
      seedKeys.mockReset();
      resetSigningKeyCacheForTesting();
    }
  });

  it("accepts a whole chain in one heartbeat, oldest first", async () => {
    const { acceptDirectoryKeys } = await import("./signing-keys");
    const a = generateSigningKey();
    const b = generateSigningKey();
    const now = Date.now();
    const result = await acceptDirectoryKeys("bay-9", [
      published(b, "bay-9", a, now + 300 * DAY),
      published(a, "bay-9", undefined, now + 100 * DAY),
    ]);
    expect(result).toEqual({
      added: [a.fingerprint, b.fingerprint],
      refused: [],
    });
  });

  it("never moves a kid to another bay, and refuses malformed keys", async () => {
    const { acceptDirectoryKeys } = await import("./signing-keys");
    const a = generateSigningKey();
    const b = generateSigningKey();
    await acceptDirectoryKeys("bay-1", [published(a, "bay-1")]);
    const stolen = await acceptDirectoryKeys("bay-2", [published(a, "bay-2")]);
    expect(stolen.refused).toEqual([
      { kid: a.fingerprint, reason: "kid belongs to another bay" },
    ]);
    const wrongKid = await acceptDirectoryKeys("bay-2", [
      { ...published(b, "bay-2"), kid: a.fingerprint },
    ]);
    expect(wrongKid.refused[0].reason).toMatch(/does not match its kid/);
    const expired = await acceptDirectoryKeys("bay-2", [
      published(b, "bay-2", undefined, Date.now() - 1),
    ]);
    expect(expired.refused[0].reason).toMatch(/future time/);
    expect(await acceptDirectoryKeys("bay-2", "nonsense")).toEqual({
      added: [],
      refused: [],
    });
    expect(await directory("bay-2")).toEqual([]);
  });
});
