import assert from "node:assert/strict";
import test from "node:test";

import { Command } from "commander";

import { registerProjectCollabCommands } from "./collab";

function makeProgram(deps: Record<string, any>) {
  const program = new Command();
  program.name("cocalc");
  const project = program.command("project");
  registerProjectCollabCommands(project, deps as any);
  return program;
}

test("project transfer-ownership requires confirmation and preserves expected owner", async () => {
  const from = "11111111-1111-4111-8111-111111111111";
  const to = "22222222-2222-4222-8222-222222222222";
  let captured: any;
  const deps = {
    withContext: async (_cmd, _label, fn) =>
      fn({
        hub: {
          projects: {
            transferProjectOwnership: async (opts) => {
              captured = opts;
            },
          },
        },
      }),
    resolveProjectFromArgOrContext: async () => ({ project_id: "project-id" }),
  };
  const args = [
    "node",
    "cocalc",
    "project",
    "transfer-ownership",
    "--project",
    "Example",
    "--from",
    from,
    "--to",
    to,
  ];
  await assert.rejects(makeProgram(deps).parseAsync(args), /--yes/);
  assert.equal(captured, undefined);
  await makeProgram(deps).parseAsync([...args, "--yes"]);
  assert.deepEqual(captured, {
    project_id: "project-id",
    from_account_id: from,
    to_account_id: to,
  });
});

test("project invite create creates a copyable email-token invite", async () => {
  let result: any;
  let captured: any;
  const deps = {
    withContext: async (_command, _label, fn) => {
      result = await fn({
        accountId: "acct-1",
        hub: {
          projects: {
            inviteCollaboratorWithoutAccount: async (opts) => {
              captured = opts;
              return {
                email_sent: false,
                email_available: true,
                manual_delivery_required: true,
                email_blocked_reason: "send_disabled_by_request",
                invites: [
                  {
                    invite_id: "invite-1",
                    project_id: "project-1",
                    inviter_account_id: "acct-1",
                    invitee_account_id: null,
                    invite_source: "email",
                    status: "pending",
                    created: new Date("2026-05-18T00:00:00Z"),
                    updated: new Date("2026-05-18T00:00:00Z"),
                    invite_url:
                      "https://example.com/invites/project/project-1/invite-1?token=t",
                    target_email: "student@example.com",
                  },
                ],
              };
            },
          },
        },
      });
    },
    resolveProjectFromArgOrContext: async (_ctx, project) => ({
      project_id: project,
      title: "Course Student",
    }),
    serializeInviteRow: (row) => row,
    compactInviteRow: (row) => row,
    normalizeUserSearchName: () => "User",
    resolveAccountByIdentifier: async () => ({ account_id: "acct-2" }),
    toIso: (value) => value,
  };

  await makeProgram(deps).parseAsync([
    "node",
    "test",
    "project",
    "invite",
    "create",
    "--project",
    "project-1",
    "--email",
    "student@example.com",
  ]);

  assert.deepEqual(captured, {
    opts: {
      project_id: "project-1",
      title: "Course Student",
      link2proj: "",
      to: "student@example.com",
      email: "",
      message: undefined,
      send_email: false,
    },
  });
  assert.equal(result.email_sent, false);
  assert.equal(result.manual_delivery_required, true);
  assert.equal(result.email_blocked_reason, "send_disabled_by_request");
  assert.equal(result.invites[0].invite_url.includes("token=t"), true);
  assert.equal(result.invites[0].target_email, "student@example.com");
});

test("project invite copy-link forwards project context", async () => {
  let result: any;
  let captured: any;
  const deps = {
    withContext: async (_command, _label, fn) => {
      result = await fn({
        hub: {
          projects: {
            copyEmailProjectInviteLink: async (opts) => {
              captured = opts;
              return {
                invite_id: "invite-1",
                invite_url:
                  "https://example.com/invites/project/project-1/invite-1?token=t",
              };
            },
          },
        },
      });
    },
    resolveProjectFromArgOrContext: async (_ctx, project) => ({
      project_id: project,
      title: "Project",
    }),
    serializeInviteRow: (row) => row,
    compactInviteRow: (row) => row,
    normalizeUserSearchName: () => "User",
    resolveAccountByIdentifier: async () => ({ account_id: "acct-2" }),
    toIso: (value) => value,
  };

  await makeProgram(deps).parseAsync([
    "node",
    "test",
    "project",
    "invite",
    "copy-link",
    "invite-1",
    "--project",
    "project-1",
  ]);

  assert.deepEqual(captured, {
    invite_id: "invite-1",
    project_id: "project-1",
  });
  assert.equal(result.invite_url.includes("token=t"), true);
});

function collabAddDeps({
  resolveError,
  createCollabInvite,
}: {
  resolveError?: Error;
  createCollabInvite: (opts: any) => Promise<any>;
}) {
  const result: { value?: any } = {};
  const deps = {
    withContext: async (_command, _label, fn) => {
      result.value = await fn({
        hub: { projects: { createCollabInvite } },
      });
    },
    resolveProjectFromArgOrContext: async (_ctx, project) => {
      if (resolveError) throw resolveError;
      return { project_id: project, title: "Visible" };
    },
    serializeInviteRow: (row) => row,
    normalizeUserSearchName: () => "User",
    resolveAccountByIdentifier: async (_ctx, user) => ({ account_id: user }),
  };
  return { deps, result };
}

const INVISIBLE = "33333333-3333-4333-8333-333333333333";
const TARGET = "44444444-4444-4444-8444-444444444444";
const addArgs = (project: string, ...extra: string[]) => [
  "node",
  "cocalc",
  "project",
  "collab",
  "add",
  "--project",
  project,
  "--user",
  TARGET,
  ...extra,
];
const notFound = (id: string) =>
  new Error(
    `project '${id}' not found - callHub: subject='hub.account.x.api', name='system.getProjectBay', code='unknown'`,
  );

test("project collab add --direct passes an invisible project uuid to the server", async () => {
  const calls: any[] = [];
  const { deps, result } = collabAddDeps({
    resolveError: notFound(INVISIBLE),
    createCollabInvite: async (opts) => {
      calls.push(opts);
      return { created: true, invite: { invite_id: "i" } };
    },
  });
  await makeProgram(deps).parseAsync(addArgs(INVISIBLE, "--direct"));
  assert.deepEqual(calls, [
    {
      project_id: INVISIBLE,
      invitee_account_id: TARGET,
      message: undefined,
      direct: true,
    },
  ]);
  assert.equal(result.value.project_id, INVISIBLE);
  assert.equal(result.value.target_account_id, TARGET);
});

test("project collab add --direct surfaces the server's refusal for a non-admin", async () => {
  const { deps } = collabAddDeps({
    resolveError: notFound(INVISIBLE),
    createCollabInvite: async () => {
      throw new Error("direct collaborator add requires admin privileges");
    },
  });
  await assert.rejects(
    makeProgram(deps).parseAsync(addArgs(INVISIBLE, "--direct")),
    /requires admin privileges/,
  );
});

test("project collab add only falls through for --direct, a uuid and a not-found lookup", async () => {
  for (const [project, extra, error] of [
    // not --direct: a normal invite still needs a visible project
    [INVISIBLE, [], notFound(INVISIBLE)],
    // a name or slug never falls through
    ["Some Project", ["--direct"], notFound("Some Project")],
    // another project's not-found does not count
    [INVISIBLE, ["--direct"], notFound(TARGET)],
    // any other lookup error is not a not-found
    [INVISIBLE, ["--direct"], new Error("rpc timeout")],
    // nor is one that merely contains the not-found text
    [
      INVISIBLE,
      ["--direct"],
      new Error(`bay unavailable: ${notFound(INVISIBLE).message}`),
    ],
    [INVISIBLE, ["--direct"], new Error(`project '${INVISIBLE}' not found.`)],
  ] as const) {
    let called = false;
    const { deps } = collabAddDeps({
      resolveError: error,
      createCollabInvite: async () => {
        called = true;
        return { created: true, invite: {} };
      },
    });
    await assert.rejects(
      makeProgram(deps).parseAsync(addArgs(project, ...extra)),
      (err: Error) => err === error,
    );
    assert.equal(called, false, `${project} ${extra.join(" ")}`);
  }
});
