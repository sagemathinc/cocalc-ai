import { randomUUID } from "node:crypto";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { AgentStore } from "./store";
import { claimAgentRpcReportExecution } from "./rpc-report-executions";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("a delivery report starts one turn", () => {
  const db = new AgentStore();
  beforeAll(async () => {
    await syncSchema({
      agent_rpc_report_executions: SCHEMA.agent_rpc_report_executions,
    });
  });
  beforeEach(async () => {
    await db.query("DELETE FROM agent_rpc_report_executions");
  });

  const execution = (attempt_id = randomUUID()) => ({
    attempt_id,
    report_id: randomUUID(),
    account_id: randomUUID(),
    project_id: randomUUID(),
    host_id: randomUUID(),
    path: "/home/user/a.chat",
    thread_id: "thread-a",
  });

  test("the first claim wins, also when they race", async () => {
    const attempt = randomUUID();
    const claims = await Promise.all(
      Array.from({ length: 5 }, () =>
        claimAgentRpcReportExecution(execution(attempt)),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    // Nor later, in another chat or by another report of the same message.
    expect(await claimAgentRpcReportExecution(execution(attempt))).toBe(false);
    expect(await claimAgentRpcReportExecution(execution())).toBe(true);
  });

  test("is kept until after the report's capability expired", async () => {
    const attempt = randomUUID();
    await claimAgentRpcReportExecution(execution(attempt));
    const { rows } = await db.query(
      `SELECT expires_at > now() + interval '7 days' AS kept
       FROM agent_rpc_report_executions WHERE attempt_id=$1`,
      [attempt],
    );
    expect(rows[0].kept).toBe(true);
  });
});
