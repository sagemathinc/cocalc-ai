/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

import getPool from "@cocalc/database/pool";
import { after, before } from "@cocalc/server/test";
import { DEFAULT_SITE_FUNDED_CLAUDE_POLICY } from "@cocalc/util/ai/site-funded-claude";
import { siteFundedCodexFinalRequestHeadroomMicrousd } from "@cocalc/util/ai/site-funded-codex";
import { uuid } from "@cocalc/util/misc";
import { ensureAiSessionsSchema } from "./acp-sessions";
import {
  ensureSiteFundedCodexReservationTables,
  finishSiteFundedCodexTurn,
  recordSiteFundedCodexUsageEvent,
  reserveSiteFundedCodexTurn,
} from "./site-funded-codex-reservations";
import {
  addSiteFundedProviderKey,
  ensureSiteFundedProviderKeyTable,
  getSiteFundedProviderKeyForReservation,
  listSiteFundedProviderKeys,
  removeSiteFundedProviderKey,
  updateSiteFundedProviderKey,
} from "./site-funded-provider-keys";

beforeAll(async () => {
  await before({ noConat: true });
  await ensureSiteFundedCodexReservationTables();
  await ensureSiteFundedProviderKeyTable();
  await ensureAiSessionsSchema();
}, 15_000);

afterAll(after);

beforeEach(async () => {
  await getPool().query("DELETE FROM site_ai_turn_reservations");
  await getPool().query("DELETE FROM site_ai_funding_periods");
  await getPool().query("DELETE FROM site_ai_provider_keys");
});

const policy = {
  ...DEFAULT_SITE_FUNDED_CLAUDE_POLICY,
  maxTurnCostMicrousd: 50_000,
  contextWindowTokens: 10_000,
  maxOutputTokensPerRequest: 1_000,
};
// What one turn holds against a key until it finishes.
const perTurn =
  policy.maxTurnCostMicrousd +
  siteFundedCodexFinalRequestHeadroomMicrousd(policy);

const reserve = (
  hostId = uuid(),
  provider: "anthropic" | "openai" = "anthropic",
) => {
  const fundedTurnId = uuid();
  return reserveSiteFundedCodexTurn({
    fundedTurnId,
    idempotencyKey: fundedTurnId,
    poolId: "site-funded-codex-free",
    poolLimitMicrousd: 100_000_000,
    globalPoolLimitMicrousd: 100_000_000,
    globalConcurrency: 100,
    accountId: uuid(),
    projectId: uuid(),
    hostId,
    membershipTier: "free",
    policy,
    provider,
  });
};

const key = (label: string, monthlyLimitMicrousd: number) =>
  addSiteFundedProviderKey({
    provider: "anthropic",
    label,
    apiKey: `sk-ant-test-${label}-0123456789`,
    monthlyLimitMicrousd,
    resetDay: 1,
    resetHour: 0,
  });

describe("site-funded provider keys", () => {
  it("stores keys encrypted, and lists them without the secret", async () => {
    await key("first", 10_000_000);
    const { rows } = await getPool().query(
      "SELECT encrypted_key FROM site_ai_provider_keys",
    );
    expect(rows[0].encrypted_key).not.toContain("sk-ant-test");
    const [info] = await listSiteFundedProviderKeys("anthropic");
    expect(info).toMatchObject({
      label: "first",
      last4: "6789",
      monthlyLimitMicrousd: 10_000_000,
      enabled: true,
      exposureMicrousd: 0,
    });
    expect(JSON.stringify(info)).not.toContain("sk-ant-test");
  });

  it("funds turns from the first key with room, then the next", async () => {
    const first = await key("first", perTurn);
    const second = await key("second", 10 * perTurn);
    const a = await reserve();
    const b = await reserve();
    if (!a.allowed || !b.allowed) throw new Error("expected admissions");
    expect(a.reservation).toMatchObject({
      provider: "anthropic",
      providerKeyId: first,
    });
    expect(b.reservation.providerKeyId).toBe(second);
    const keys = await listSiteFundedProviderKeys("anthropic");
    expect(keys.map(({ exposureMicrousd }) => exposureMicrousd)).toEqual([
      perTurn,
      perTurn,
    ]);
  });

  it("frees a key's room as turns finish, counting what they spent", async () => {
    const only = await key("only", perTurn);
    const a = await reserve();
    if (!a.allowed) throw new Error("expected admission");
    expect(await reserve()).toMatchObject({
      allowed: false,
      code: "provider_keys_exhausted",
    });
    await recordSiteFundedCodexUsageEvent({
      eventId: uuid(),
      reservationId: a.reservation.reservationId,
      requestSequence: 1,
      model: policy.model,
      inputTokens: 1_000,
      outputTokens: 100,
    });
    await finishSiteFundedCodexTurn({
      reservationId: a.reservation.reservationId,
      status: "committed",
    });
    const [info] = await listSiteFundedProviderKeys("anthropic");
    // 1,000 x 0.10 + 100 x 0.50
    expect(info).toMatchObject({ keyId: only, exposureMicrousd: 150 });
    await updateSiteFundedProviderKey({
      keyId: only,
      monthlyLimitMicrousd: perTurn + 150,
    });
    expect((await reserve()).allowed).toBe(true);
  });

  it("starts a key's spend again at its reset point", async () => {
    const only = await key("only", perTurn);
    const a = await reserve();
    if (!a.allowed) throw new Error("expected admission");
    expect((await reserve()).allowed).toBe(false);
    // That turn was in an earlier month of this key.
    await getPool().query(
      "UPDATE site_ai_turn_reservations SET started_at = NOW() - interval '40 days'",
    );
    const b = await reserve();
    expect(b.allowed && b.reservation.providerKeyId).toBe(only);
  });

  it("skips disabled and removed keys, and refuses when none is left", async () => {
    const first = await key("first", 10 * perTurn);
    const second = await key("second", 10 * perTurn);
    await updateSiteFundedProviderKey({ keyId: first, enabled: false });
    const a = await reserve();
    expect(a.allowed && a.reservation.providerKeyId).toBe(second);
    await removeSiteFundedProviderKey(second);
    expect(await reserve()).toMatchObject({
      allowed: false,
      code: "provider_keys_exhausted",
      reason: expect.stringContaining("Claude"),
    });
  });

  it("follows the configured order", async () => {
    const first = await key("first", 10 * perTurn);
    const second = await key("second", 10 * perTurn);
    await updateSiteFundedProviderKey({ keyId: second, position: 0 });
    await updateSiteFundedProviderKey({ keyId: first, position: 1 });
    const a = await reserve();
    expect(a.allowed && a.reservation.providerKeyId).toBe(second);
  });

  it("never funds a Codex turn from a site key", async () => {
    await key("first", 10 * perTurn);
    const a = await reserve(uuid(), "openai");
    if (!a.allowed) throw new Error("expected admission");
    expect(a.reservation.provider).toBe("openai");
    expect(a.reservation.providerKeyId).toBeUndefined();
  });

  it("gives the key only to the host running an active Claude turn", async () => {
    await key("first", 10 * perTurn);
    const host = uuid();
    const a = await reserve(host);
    if (!a.allowed) throw new Error("expected admission");
    const reservationId = a.reservation.reservationId;
    await expect(
      getSiteFundedProviderKeyForReservation({ reservationId, hostId: host }),
    ).resolves.toBe("sk-ant-test-first-0123456789");
    await expect(
      getSiteFundedProviderKeyForReservation({ reservationId, hostId: uuid() }),
    ).rejects.toThrow("does not belong to host");
    const codex = await reserve(host, "openai");
    if (!codex.allowed) throw new Error("expected admission");
    await expect(
      getSiteFundedProviderKeyForReservation({
        reservationId: codex.reservation.reservationId,
        hostId: host,
      }),
    ).rejects.toThrow("not funded by a site key");
    // Past its deadline, though not yet marked expired.
    await getPool().query(
      "UPDATE site_ai_turn_reservations SET expires_at = NOW() - interval '1 second' WHERE reservation_id = $1",
      [reservationId],
    );
    await expect(
      getSiteFundedProviderKeyForReservation({ reservationId, hostId: host }),
    ).rejects.toThrow("has expired");
    await finishSiteFundedCodexTurn({ reservationId, status: "committed" });
    await expect(
      getSiteFundedProviderKeyForReservation({ reservationId, hostId: host }),
    ).rejects.toThrow("not active");
  });

  it("refuses invalid key settings", async () => {
    await expect(key("bad", -1)).rejects.toThrow("monthly limit");
    await expect(
      addSiteFundedProviderKey({
        provider: "anthropic",
        label: "bad",
        apiKey: "sk-ant-test-0123456789",
        monthlyLimitMicrousd: 1,
        resetDay: 31,
        resetHour: 0,
      }),
    ).rejects.toThrow("day 1-28");
    await expect(
      addSiteFundedProviderKey({
        provider: "openai",
        label: "bad",
        apiKey: "sk-test-0123456789",
        monthlyLimitMicrousd: 1,
        resetDay: 1,
        resetHour: 0,
      }),
    ).rejects.toThrow("Anthropic only");
  });
});
