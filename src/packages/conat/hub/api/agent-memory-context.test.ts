import { hosts } from "./hosts";

const HOST = "00000000-0000-4000-8000-000000000001";
const PROJECT = "00000000-0000-4000-8000-000000000002";
const ACCOUNT = "00000000-0000-4000-8000-000000000003";

describe("hosts.getAgentMemoryContext auth", () => {
  it("keeps the turn's owner_account_id through host auth", async () => {
    const args = await hosts.getAgentMemoryContext({
      args: [{ project_id: PROJECT, owner_account_id: ACCOUNT }],
      host_id: HOST,
    });
    expect(args[0]).toEqual({
      project_id: PROJECT,
      owner_account_id: ACCOUNT,
      host_id: HOST,
    });
  });

  it("strips account_id, so the account must not be sent that way", async () => {
    const args = await hosts.getAgentMemoryContext({
      args: [{ project_id: PROJECT, account_id: ACCOUNT }],
      host_id: HOST,
    });
    expect(args[0].account_id).toBeUndefined();
  });

  it("rejects callers that are not hosts", async () => {
    await expect(
      hosts.getAgentMemoryContext({
        args: [{ project_id: PROJECT, owner_account_id: ACCOUNT }],
        account_id: ACCOUNT,
      }),
    ).rejects.toThrow("must be a host");
  });
});
