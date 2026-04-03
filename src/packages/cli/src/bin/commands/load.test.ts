import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";

import { registerLoadCommand, type LoadCommandDeps } from "./load";

type Capture = {
  data?: any;
  accountBayCalls: number;
  listBayCalls: number;
  projectQueryCalls: number;
  lastLimit?: number;
  projectCollaboratorListCalls: string[];
  myCollaboratorListCalls: number[];
  adminCreateCalls: string[];
  userSearchCalls: string[];
  createCollabCalls: Array<{ project_id: string; invitee_account_id: string }>;
};

function makeDeps(capture: Capture): LoadCommandDeps {
  return {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-4111-8111-111111111111",
        hub: {
          system: {
            getAccountBay: async () => {
              capture.accountBayCalls += 1;
              return { bay_id: "bay-0" };
            },
            listBays: async () => {
              capture.listBayCalls += 1;
              return [{ bay_id: "bay-0" }, { bay_id: "bay-1" }];
            },
            adminCreateUser: async (opts) => {
              capture.adminCreateCalls.push(opts.email);
              if (opts.email === "fixture-0002@load.test") {
                const err: any = new Error(
                  "an account with email already exists",
                );
                err.code = "23505";
                throw err;
              }
              return {
                account_id: `created-${opts.email}`,
                email_address: opts.email,
              };
            },
            userSearch: async ({ query }) => {
              capture.userSearchCalls.push(query);
              if (query === "fixture-0002@load.test") {
                return [
                  {
                    account_id: "existing-fixture-0002",
                    email_address: "fixture-0002@load.test",
                    first_name: "Load",
                    last_name: "fixture-2",
                  },
                ];
              }
              return [];
            },
          },
          projects: {
            listCollaborators: async ({ project_id }) => {
              capture.projectCollaboratorListCalls.push(project_id);
              return [
                {
                  account_id: "owner-1",
                  group: "owner",
                },
                {
                  account_id: "collab-1",
                  group: "collaborator",
                },
                {
                  account_id: "collab-2",
                  group: "collaborator",
                },
              ];
            },
            listMyCollaborators: async ({ limit }) => {
              capture.myCollaboratorListCalls.push(limit);
              return [
                {
                  account_id: "collab-1",
                  shared_projects: 12,
                },
                {
                  account_id: "collab-2",
                  shared_projects: 3,
                },
              ];
            },
            createCollabInvite: async ({ project_id, invitee_account_id }) => {
              capture.createCollabCalls.push({
                project_id,
                invitee_account_id,
              });
              if (invitee_account_id === "existing-fixture-0002") {
                throw new Error("target account is already a collaborator");
              }
              return {
                created: true,
                invite: {
                  invite_id: "invite-1",
                },
              };
            },
          },
        },
      };
      capture.data = await fn(ctx);
    },
    queryProjects: async ({ limit }) => {
      capture.projectQueryCalls += 1;
      capture.lastLimit = limit;
      return [
        {
          project_id: "22222222-2222-4222-8222-222222222222",
          host_id: "host-1",
        },
      ];
    },
    resolveProjectFromArgOrContext: async (_ctx, identifier) => ({
      project_id: `project-${identifier}`,
      title: `Project ${identifier}`,
    }),
  };
}

test("load bootstrap summarizes repeated control-plane calls", async () => {
  const capture: Capture = {
    accountBayCalls: 0,
    listBayCalls: 0,
    projectQueryCalls: 0,
    projectCollaboratorListCalls: [],
    myCollaboratorListCalls: [],
    adminCreateCalls: [],
    userSearchCalls: [],
    createCollabCalls: [],
  };
  const program = new Command();
  registerLoadCommand(program, makeDeps(capture));

  await program.parseAsync([
    "node",
    "test",
    "load",
    "bootstrap",
    "--iterations",
    "3",
    "--warmup",
    "1",
    "--concurrency",
    "2",
  ]);

  assert.equal(capture.accountBayCalls, 4);
  assert.equal(capture.listBayCalls, 4);
  assert.equal(capture.data.scenario, "bootstrap");
  assert.equal(capture.data.iterations, 3);
  assert.equal(capture.data.warmup, 1);
  assert.equal(capture.data.concurrency, 2);
  assert.equal(capture.data.successes, 3);
  assert.equal(capture.data.failures, 0);
  assert.equal(capture.data.last_result.home_bay_id, "bay-0");
  assert.equal(capture.data.last_result.visible_bay_count, 2);
  assert.ok(typeof capture.data.ops_per_sec === "number");
});

test("load projects respects the requested limit", async () => {
  const capture: Capture = {
    accountBayCalls: 0,
    listBayCalls: 0,
    projectQueryCalls: 0,
    projectCollaboratorListCalls: [],
    myCollaboratorListCalls: [],
    adminCreateCalls: [],
    userSearchCalls: [],
    createCollabCalls: [],
  };
  const program = new Command();
  registerLoadCommand(program, makeDeps(capture));

  await program.parseAsync([
    "node",
    "test",
    "load",
    "projects",
    "--iterations",
    "2",
    "--warmup",
    "1",
    "--concurrency",
    "4",
    "--limit",
    "25",
  ]);

  assert.equal(capture.projectQueryCalls, 3);
  assert.equal(capture.lastLimit, 25);
  assert.equal(capture.data.scenario, "projects");
  assert.equal(capture.data.iterations, 2);
  assert.equal(capture.data.warmup, 1);
  assert.equal(capture.data.concurrency, 3);
  assert.equal(capture.data.successes, 2);
  assert.equal(capture.data.failures, 0);
  assert.equal(
    capture.data.last_result.first_project_id,
    "22222222-2222-4222-8222-222222222222",
  );
});

test("load collaborators measures project-scoped collaborator listings", async () => {
  const capture: Capture = {
    accountBayCalls: 0,
    listBayCalls: 0,
    projectQueryCalls: 0,
    projectCollaboratorListCalls: [],
    myCollaboratorListCalls: [],
    adminCreateCalls: [],
    userSearchCalls: [],
    createCollabCalls: [],
  };
  const program = new Command();
  registerLoadCommand(program, makeDeps(capture));

  await program.parseAsync([
    "node",
    "test",
    "load",
    "collaborators",
    "--project",
    "demo",
    "--iterations",
    "2",
    "--warmup",
    "1",
    "--concurrency",
    "4",
  ]);

  assert.deepEqual(capture.projectCollaboratorListCalls, [
    "project-demo",
    "project-demo",
    "project-demo",
  ]);
  assert.equal(capture.data.scenario, "collaborators");
  assert.equal(capture.data.iterations, 2);
  assert.equal(capture.data.warmup, 1);
  assert.equal(capture.data.concurrency, 3);
  assert.equal(capture.data.successes, 2);
  assert.equal(capture.data.failures, 0);
  assert.equal(capture.data.last_result.project_id, "project-demo");
  assert.equal(capture.data.last_result.collaborator_count, 3);
  assert.equal(capture.data.last_result.owner_count, 1);
  assert.equal(capture.data.last_result.non_owner_count, 2);
});

test("load my-collaborators respects the requested limit", async () => {
  const capture: Capture = {
    accountBayCalls: 0,
    listBayCalls: 0,
    projectQueryCalls: 0,
    projectCollaboratorListCalls: [],
    myCollaboratorListCalls: [],
    adminCreateCalls: [],
    userSearchCalls: [],
    createCollabCalls: [],
  };
  const program = new Command();
  registerLoadCommand(program, makeDeps(capture));

  await program.parseAsync([
    "node",
    "test",
    "load",
    "my-collaborators",
    "--iterations",
    "2",
    "--warmup",
    "1",
    "--concurrency",
    "4",
    "--limit",
    "25",
  ]);

  assert.deepEqual(capture.myCollaboratorListCalls, [25, 25, 25]);
  assert.equal(capture.data.scenario, "my-collaborators");
  assert.equal(capture.data.iterations, 2);
  assert.equal(capture.data.warmup, 1);
  assert.equal(capture.data.concurrency, 3);
  assert.equal(capture.data.successes, 2);
  assert.equal(capture.data.failures, 0);
  assert.equal(capture.data.last_result.collaborator_count, 2);
  assert.equal(capture.data.last_result.first_account_id, "collab-1");
  assert.equal(capture.data.last_result.first_shared_projects, 12);
  assert.equal(capture.data.last_result.max_shared_projects, 12);
});

test("load seed users creates or reuses accounts and adds collaborators", async () => {
  const capture: Capture = {
    accountBayCalls: 0,
    listBayCalls: 0,
    projectQueryCalls: 0,
    projectCollaboratorListCalls: [],
    myCollaboratorListCalls: [],
    adminCreateCalls: [],
    userSearchCalls: [],
    createCollabCalls: [],
  };
  const program = new Command();
  registerLoadCommand(program, makeDeps(capture));

  await program.parseAsync([
    "node",
    "test",
    "load",
    "seed",
    "users",
    "--count",
    "3",
    "--prefix",
    "fixture",
    "--project",
    "demo",
  ]);

  assert.deepEqual(capture.adminCreateCalls, [
    "fixture-0001@load.test",
    "fixture-0002@load.test",
    "fixture-0003@load.test",
  ]);
  assert.deepEqual(capture.userSearchCalls, ["fixture-0002@load.test"]);
  assert.equal(capture.createCollabCalls.length, 3);
  assert.equal(capture.data.scenario, "seed-users");
  assert.equal(capture.data.count_requested, 3);
  assert.equal(capture.data.accounts_created, 2);
  assert.equal(capture.data.accounts_reused, 1);
  assert.equal(capture.data.collaborators_added, 2);
  assert.equal(capture.data.collaborators_existing, 1);
  assert.equal(capture.data.failures, 0);
  assert.equal(capture.data.project_id, "project-demo");
  assert.equal(capture.data.project_title, "Project demo");
  assert.equal(capture.data.sample_rows[1].account_status, "reused");
  assert.equal(capture.data.sample_rows[1].collaborator_status, "existing");
});
