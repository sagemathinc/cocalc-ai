import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import {
  claimAgentRpcAdmissionState,
  createAgentRpcAdmissionState,
  deleteAgentRpcAdmissionState,
  findAgentRpcPreparation,
  getAgentRpcAdmissionState,
  hashAgentRpcAdmissionBinding,
} from "./admission-state";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("shared agent RPC admission state", () => {
  beforeAll(async () => {
    await syncSchema({
      agent_rpc_admission_state: SCHEMA.agent_rpc_admission_state,
    });
  });

  beforeEach(async () => {
    await getPool().query("DELETE FROM agent_rpc_admission_state");
  });

  const state = (kind: "permit" | "preparation") => ({
    token_id: randomUUID(),
    kind,
    binding_hash: hashAgentRpcAdmissionBinding("canonical request"),
    host_id: randomUUID(),
    project_id: randomUUID(),
    account_id: randomUUID(),
    expires_at: new Date(Date.now() + 30_000),
  });

  test("permits support repeated authorization checks until explicitly released", async () => {
    const permit = state("permit");
    await createAgentRpcAdmissionState(permit);
    expect(await getAgentRpcAdmissionState(permit)).toMatchObject(permit);
    expect(await getAgentRpcAdmissionState(permit)).toMatchObject(permit);
    await deleteAgentRpcAdmissionState(permit);
    expect(await getAgentRpcAdmissionState(permit)).toBeUndefined();
  });

  test("a preparation is atomically claimed once across concurrent callers", async () => {
    const preparation = state("preparation");
    await createAgentRpcAdmissionState(preparation);
    expect(
      await claimAgentRpcAdmissionState({
        ...preparation,
        binding_hash: hashAgentRpcAdmissionBinding("different request"),
      }),
    ).toBeUndefined();
    const claims = await Promise.all([
      claimAgentRpcAdmissionState(preparation),
      claimAgentRpcAdmissionState(preparation),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject(preparation);
  });

  test("expired capabilities fail closed and are pruned on later admission", async () => {
    const expired = state("permit");
    await getPool().query(
      `INSERT INTO agent_rpc_admission_state
       (token_id,kind,binding_hash,host_id,project_id,account_id,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,now()-interval '1 second')`,
      [
        expired.token_id,
        expired.kind,
        expired.binding_hash,
        expired.host_id,
        expired.project_id,
        expired.account_id,
      ],
    );
    expect(await getAgentRpcAdmissionState(expired)).toBeUndefined();
    await createAgentRpcAdmissionState(state("permit"));
    expect(
      (
        await getPool().query(
          "SELECT 1 FROM agent_rpc_admission_state WHERE token_id=$1",
          [expired.token_id],
        )
      ).rows,
    ).toEqual([]);
  });

  test("a send's own preparation covers its permit when permits are full", async () => {
    const project_id = randomUUID();
    const preparation = { ...state("preparation"), project_id };
    await createAgentRpcAdmissionState(preparation);
    // Fill the recipient's permit limit.
    for (let i = 0; i < 32; i++)
      await createAgentRpcAdmissionState({ ...state("permit"), project_id });
    const permit = {
      ...state("permit"),
      project_id,
      host_id: preparation.host_id,
      account_id: preparation.account_id,
    };
    await expect(createAgentRpcAdmissionState(permit)).rejects.toMatchObject({
      scope: "recipient",
    });
    // A binding that does not match the live preparation is no cover.
    await expect(
      createAgentRpcAdmissionState(permit, {
        coveredBy: { ...preparation, binding_hash: "other" },
      }),
    ).rejects.toMatchObject({ scope: "recipient" });
    expect(await findAgentRpcPreparation(preparation)).toMatchObject({
      token_id: preparation.token_id,
    });
    await createAgentRpcAdmissionState(permit, { coveredBy: preparation });
    // Finding never consumes: the preparation can still be claimed once.
    expect(
      await claimAgentRpcAdmissionState({
        ...preparation,
        kind: "preparation",
      }),
    ).toMatchObject({ token_id: preparation.token_id });
    expect(await findAgentRpcPreparation(preparation)).toBeUndefined();
  });

  test("project capacity is aggregate across independent callers", async () => {
    const first = state("preparation");
    const second = {
      ...state("preparation"),
      project_id: first.project_id,
    };
    const rejected = {
      ...state("preparation"),
      project_id: first.project_id,
    };
    await createAgentRpcAdmissionState(first);
    await createAgentRpcAdmissionState(second);
    await expect(createAgentRpcAdmissionState(rejected)).rejects.toMatchObject({
      message: "recipient project messaging capacity full",
      scope: "recipient",
      active: 2,
      limit: 2,
    });
  });
});
