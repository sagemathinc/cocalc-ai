import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { reconcileProjectApiKeyRevocations } from "./project-membership-maintenance";

const resolve = jest.fn();
jest.mock("./project-membership-revocation", () => ({
  resolveProjectApiKeyRevocation: (...args) => resolve(...args),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-1",
}));
const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
describeDb("pending project API delegation scan", () => {
  const pool = getPool();
  const project = randomUUID();
  beforeAll(async () => {
    await pool.query(`CREATE TABLE projects(project_id uuid PRIMARY KEY,owning_bay_id text,deleted boolean,
      api_key_membership_revocations jsonb,api_key_membership_pending boolean)`);
  });
  beforeEach(async () => {
    await pool.query("DELETE FROM projects");
    resolve.mockReset().mockResolvedValue(true);
  });
  it("bounds each pass and advances past failures before wrapping", async () => {
    const entries = Object.fromEntries(
      Array.from({ length: 40 }, () => [
        randomUUID(),
        { pending: true, generation: randomUUID() },
      ]),
    );
    await pool.query(
      "INSERT INTO projects VALUES($1,'bay-1',false,$2::jsonb,true)",
      [project, JSON.stringify(entries)],
    );
    resolve.mockRejectedValue(Error("home unavailable"));
    const first = await reconcileProjectApiKeyRevocations();
    expect(first.scanned).toBe(32);
    expect(first.resolved).toBe(0);
    const second = await reconcileProjectApiKeyRevocations(first.cursor);
    expect(second.scanned).toBe(8);
    const end = await reconcileProjectApiKeyRevocations(second.cursor);
    expect(end).toEqual({ scanned: 0, resolved: 0, cursor: undefined });
    expect(
      new Set(resolve.mock.calls.map(([row]) => row.account_id)).size,
    ).toBe(40);
    expect((await reconcileProjectApiKeyRevocations(end.cursor)).scanned).toBe(
      32,
    );
  });
  it("does not scan other owners, deleted projects, or resolved barriers", async () => {
    const account = randomUUID();
    const entries = {
      [account]: { pending: true, generation: randomUUID() },
      [randomUUID()]: { pending: false, generation: randomUUID(), cutoff: "5" },
    };
    for (const [bay, deleted] of [
      ["bay-1", false],
      ["bay-2", false],
      ["bay-1", true],
    ])
      await pool.query("INSERT INTO projects VALUES($1,$2,$3,$4::jsonb,true)", [
        randomUUID(),
        bay,
        deleted,
        JSON.stringify(entries),
      ]);
    const result = await reconcileProjectApiKeyRevocations();
    expect(result.scanned).toBe(1);
    expect(result.resolved).toBe(1);
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: account }),
    );
  });
});
