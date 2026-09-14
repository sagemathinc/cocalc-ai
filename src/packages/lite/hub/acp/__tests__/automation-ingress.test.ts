import passwordHash from "@cocalc/backend/auth/password-hash";
import { createLiteConatAuth } from "../../../conat-auth";

it("Lite requires human-cookie provenance for automation, not an agent's claimed writer", async () => {
  const account_id = "00000000-0000-4000-8000-000000000001";
  const project_id = "00000000-0000-4000-8000-000000000002";
  const policy = createLiteConatAuth({
    account_id,
    project_id,
    bindHost: "127.0.0.1",
    AUTH_TOKEN: "human-secret",
    AGENT_TOKEN: "agent-secret",
  });
  const agent = await policy.getUser({
    handshake: {
      auth: {
        bearer: "agent-secret",
        auth_actor: "account",
        account_id,
      },
      headers: {},
    },
  } as any);
  expect(agent.auth_actor).toBe("agent");
  const subject = `acp.project-${project_id}.account-${account_id}.automation`;
  await expect(
    policy.isAllowed({ user: agent, type: "pub", subject }),
  ).resolves.toBe(false);
  const human = await policy.getUser({
    handshake: {
      auth: {},
      headers: {
        cookie: `cocalc-lite-auth=${encodeURIComponent(passwordHash("human-secret"))}`,
      },
    },
  } as any);
  await expect(
    policy.isAllowed({ user: human, type: "pub", subject }),
  ).resolves.toBe(true);
  await expect(
    policy.isAllowed({ user: human, type: "sub", subject }),
  ).resolves.toBe(false);
  await expect(
    policy.isAllowed({
      user: human,
      type: "pub",
      subject: `acp.project-${project_id}.account-00000000-0000-4000-8000-000000000003.automation`,
    }),
  ).resolves.toBe(false);
});
