import { randomUUID } from "node:crypto";
import {
  EXTERNAL_AGENT_TOKEN_PREFIX,
  parseExternalAgentToken,
  validateExternalAgentApproval,
  validateExternalAgentLabel,
  externalAgentSubject,
  externalAgentInbox,
  allowsExternalAgentSubject,
  parseExternalAgentSubject,
} from "./external";
import { validateAgentRpcSource, agentRpcEnvelopeKey } from "./rpc";

const account_id = randomUUID(),
  installation_id = randomUUID();
const secret = "a".repeat(64);
const token = `${EXTERNAL_AGENT_TOKEN_PREFIX}${account_id}.${installation_id}.${secret}`;

test("external subjects are installation sealed, with no general account or native access", () => {
  const subject = externalAgentSubject(account_id, installation_id);
  expect(parseExternalAgentSubject(subject)).toEqual({
    account_id,
    installation_id,
  });
  expect(
    allowsExternalAgentSubject(account_id, installation_id, subject, "pub"),
  ).toBe(true);
  expect(
    allowsExternalAgentSubject(
      account_id,
      installation_id,
      `${externalAgentInbox(account_id, installation_id)}.response`,
      "sub",
    ),
  ).toBe(true);
  for (const other of [
    subject + ".extra",
    "agent-external.*.*",
    `hub.account.${account_id}.api`,
    externalAgentSubject(account_id, randomUUID()),
    "agent-messaging.x.y",
  ])
    for (const type of ["pub", "sub"] as const)
      expect(
        allowsExternalAgentSubject(account_id, installation_id, other, type),
      ).toBe(false);
});

test("external source cannot claim a project/run; permit binds installation", () => {
  const source = {
    kind: "external" as const,
    account_id,
    installation_id,
    agent_id: randomUUID(),
  };
  expect(() => validateAgentRpcSource(source)).not.toThrow();
  expect(() => validateAgentRpcSource(source, randomUUID())).toThrow();
  expect(() =>
    validateAgentRpcSource({ ...source, project_id: randomUUID() } as any),
  ).toThrow();
  expect(() =>
    validateAgentRpcSource({
      agent_id: randomUUID(),
      project_id: randomUUID(),
    }),
  ).toThrow();
  const e: any = {
    source,
    target: { agent_id: randomUUID(), project_id: randomUUID() },
  };
  expect(agentRpcEnvelopeKey(e)).not.toBe(
    agentRpcEnvelopeKey({
      ...e,
      source: { ...source, installation_id: randomUUID() },
    }),
  );
});

test("external credential parser yields explicit routing, never project or native run fields", () => {
  expect(parseExternalAgentToken(token)).toEqual({
    account_id,
    installation_id,
    secret,
  });
});

test.each([
  "",
  "cocalc_agent_v1.some-native-credential",
  token + ".extra",
  token.slice(0, -1),
  token.replace(secret, "A".repeat(64)),
  token.replace(account_id, "not-an-account"),
  token.replace(installation_id, "project"),
])("invalid external credential rejects: %s", (invalid) => {
  expect(() => parseExternalAgentToken(invalid)).toThrow();
});

test.each(["", " ", "name\nlogin", "x".repeat(81)])(
  "invalid installation label rejects",
  (label) => {
    expect(() => validateExternalAgentLabel(label)).toThrow();
  },
);

test("approval is bounded send-only; target endpoints are native and precise", () => {
  const request = {
    installation_id,
    ttl_seconds: 3600,
    targets: [{ agent_id: randomUUID(), project_id: randomUUID() }],
  };
  expect(() => validateExternalAgentApproval(request)).not.toThrow();
  for (const extra of [
    { both_directions: true },
    { allow_guidance: true },
    { scopes: ["*"] },
  ])
    expect(() =>
      validateExternalAgentApproval({ ...request, ...extra }),
    ).toThrow("unexpected");
  expect(() =>
    validateExternalAgentApproval({ ...request, ttl_seconds: Infinity }),
  ).toThrow();
  expect(() =>
    validateExternalAgentApproval({
      ...request,
      targets: [...request.targets, ...request.targets],
    }),
  ).toThrow("duplicate");
  expect(() =>
    validateExternalAgentApproval({
      ...request,
      targets: [{ agent_id: randomUUID() } as any],
    }),
  ).toThrow();
});
