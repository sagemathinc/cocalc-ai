import {
  agentIdentityControlSubject,
  createInterBayAgentIdentityClient,
} from "./agent-identities";
import { DataEncoding, encode, decode } from "@cocalc/conat/core/codec";

test.each(["", "bay.*", "bay.>", "bay one", "https://other/site"])(
  "rejects invalid subject component %s",
  (bay) => {
    expect(() => agentIdentityControlSubject(bay)).toThrow("invalid bay_id");
  },
);

test.each([
  "list",
  "resolve",
  "register",
  "get",
  "listGrants",
  "listMessageReceipts",
] as const)(
  "%s uses the exact versioned owner subject with a bounded timeout",
  async (method) => {
    const fastRpcRequest = jest.fn(async () => ({
      raw: encode({ encoding: DataEncoding.MsgPack, mesg: [] }),
    }));
    const client = createInterBayAgentIdentityClient({
      client: { fastRpcRequest } as any,
      bay_id: "bay-2",
    });
    const request = {
      account_id: "account",
      project_id: "project",
      agent_id: "agent",
      path: "test.chat",
      thread_id: "thread",
      route: { bay_id: "bay-2", epoch: 3 },
      fresh_auth_at: 1000,
    };
    await client[method](request);
    expect(fastRpcRequest).toHaveBeenCalledWith(
      "bay.bay-2.rpc.agent-identities.v1",
      { raw: expect.any(Uint8Array) },
      { timeout: 15_000 },
    );
    expect(
      decode({
        encoding: DataEncoding.MsgPack,
        data: fastRpcRequest.mock.calls[0][1].raw,
      }),
    ).toEqual({ name: method, args: [request] });
  },
);
