import { personalUrlDestination } from "./personal-url-navigation";

jest.mock("./history", () => ({
  load_target: jest.fn(),
  replace_url: jest.fn(),
}));

const owner = { account_id: "a", username: "alice", redirect: false };
const base = {
  owner,
  kind: "chats" as const,
  alias: "x",
  canonical_path: "/u/alice/chats/x",
};
const project_id = "33333333-3333-4333-8333-333333333333";

test("resolved targets open their canonical app page", () => {
  const open = (target) =>
    personalUrlDestination({ ...base, status: "resolved", target });
  expect(
    open({ kind: "conversation", project_id, conversation_id: "c1" }),
  ).toBe(`people/conversations/${project_id}/c1`);
  expect(open({ kind: "person", person_id: "p1" })).toBe(
    "people/collaborators/p1",
  );
  expect(open({ kind: "agent", project_id, agent_id: "g1" })).toBe("agents/g1");
  expect(open({ kind: "artifact", project_id, entry_id: "e/1" })).toBe(
    `artifacts/${project_id}/e/1`,
  );
  expect(open({ kind: "project", project_id })).toBe(`projects/${project_id}`);
  expect(
    personalUrlDestination({
      ...base,
      kind: "projects",
      status: "resolved",
      rest: "files/notes/",
      target: { kind: "project", project_id },
    }),
  ).toBe(`projects/${project_id}/files/notes/`);
});

test("denied links go to the project's access request page", () => {
  expect(
    personalUrlDestination({ ...base, status: "access-denied", project_id }),
  ).toBe(`projects/${project_id}`);
  expect(personalUrlDestination({ ...base, status: "unavailable" })).toBe(null);
});

test("my own named agent or artifact keeps its name in the address", () => {
  const mine = { ...owner, account_id: "me" };
  expect(
    personalUrlDestination(
      {
        ...base,
        owner: mine,
        kind: "agents",
        alias: "agent-1",
        status: "resolved",
        target: { kind: "agent", project_id, agent_id: "g1" },
      },
      "me",
    ),
  ).toBe("agents/agent-1");
  expect(
    personalUrlDestination(
      {
        ...base,
        owner: mine,
        kind: "artifacts",
        alias: "plan",
        status: "resolved",
        target: { kind: "artifact", project_id, entry_id: "e1" },
      },
      "me",
    ),
  ).toBe("artifacts/plan");
});
