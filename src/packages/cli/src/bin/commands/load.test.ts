import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";

import { registerLoadCommand, type LoadCommandDeps } from "./load";

type Capture = {
  data?: any;
  accountBayCalls: number;
  listBayCalls: number;
  projectBayCalls?: string[];
  hostBayCalls?: string[];
  routingContextCalls?: Array<{
    project_id: string;
    host_id?: string | null;
    user_account_id?: string;
  }>;
  bayOpsOverviewCalls?: number;
  bayOpsDetailCalls?: string[];
  projectQueryCalls: number;
  lastLimit?: number;
  projectCollaboratorListCalls: string[];
  myCollaboratorListCalls: number[];
  mentionQueryCalls: number[];
  adminCreateCalls: string[];
  userSearchCalls: string[];
  createCollabCalls: Array<{ project_id: string; invitee_account_id: string }>;
  removeCollabCalls: Array<{ project_id: string; account_id: string }>;
};

function makeDeps(capture: Capture): LoadCommandDeps {
  capture.projectBayCalls ??= [];
  capture.hostBayCalls ??= [];
  capture.routingContextCalls ??= [];
  capture.bayOpsOverviewCalls ??= 0;
  capture.bayOpsDetailCalls ??= [];
  return {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-4111-8111-111111111111",
        hub: {
          db: {
            userQuery: async ({ options }) => {
              capture.mentionQueryCalls.push(options?.[0]?.limit);
              return {
                mentions: [
                  {
                    time: "2026-04-04T00:00:00.000Z",
                    project_id: "mention-project-1",
                    path: "notes/chat.sage-chat",
                    target: "target-1",
                  },
                  {
                    time: "2026-04-03T00:00:00.000Z",
                    project_id: "mention-project-2",
                    path: "worksheet.sagews",
                    target: "target-2",
                  },
                ],
              };
            },
          },
          system: {
            getAccountBay: async () => {
              capture.accountBayCalls += 1;
              return { home_bay_id: "bay-0" };
            },
            listBays: async () => {
              capture.listBayCalls += 1;
              return [{ bay_id: "bay-0" }, { bay_id: "bay-1" }];
            },
            getProjectBay: async ({ project_id }) => {
              capture.projectBayCalls!.push(project_id);
              return { project_id, owning_bay_id: "bay-1" };
            },
            getHostBay: async ({ host_id }) => {
              capture.hostBayCalls!.push(host_id);
              return { host_id, bay_id: "bay-2" };
            },
            getRoutingContext: async ({
              project_id,
              host_id,
              user_account_id,
            }) => {
              capture.routingContextCalls!.push({
                project_id,
                host_id,
                user_account_id,
              });
              return {
                account: { home_bay_id: "bay-0" },
                project: { project_id, owning_bay_id: "bay-1" },
                host: host_id == null ? null : { host_id, bay_id: "bay-2" },
              };
            },
            getBayOpsOverview: async () => {
              capture.bayOpsOverviewCalls! += 1;
              return {
                bays: [
                  { bay_id: "bay-0" },
                  { bay_id: "bay-1" },
                  { bay_id: "bay-2" },
                ],
              };
            },
            getBayOpsDetail: async ({ bay_id }) => {
              capture.bayOpsDetailCalls!.push(bay_id);
              return {
                bay_id,
                routed: bay_id !== "bay-0",
                load: { bay_id },
                backups: { bay_id },
                load_error: null,
                backups_error: null,
              };
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
              const exact = `${query ?? ""}`.trim().toLowerCase();
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
              const cycleMatch = exact.match(/^cycle-(\d+)@load\.test$/);
              if (cycleMatch) {
                const suffix = cycleMatch[1];
                return [
                  {
                    account_id: `existing-cycle-${suffix}`,
                    email_address: exact,
                    first_name: "Load",
                    last_name: `cycle-${suffix}`,
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
            removeCollaborator: async ({ opts }) => {
              capture.removeCollabCalls.push({
                project_id: opts.project_id,
                account_id: opts.account_id,
              });
            },
          },
        },
      };
      capture.data = await fn(ctx);
    },
    runLocalCommand: async (_command, _label, fn) => {
      capture.data = await fn({});
    },
    queryProjects: async ({ limit }) => {
      capture.projectQueryCalls += 1;
      capture.lastLimit = limit;
      return [
        {
          project_id: "22222222-2222-4222-8222-222222222222",
          host_id: "host-1",
        },
        {
          project_id: "project-demo",
          host_id: "host-2",
        },
      ];
    },
    resolveProjectFromArgOrContext: async (_ctx, identifier) => ({
      project_id: `project-${identifier}`,
      title: `Project ${identifier}`,
      host_id: "host-2",
    }),
  };
}

test("load conat-messages measures direct Conat request response calls", async () => {
  const capture: Capture = {
    accountBayCalls: 0,
    listBayCalls: 0,
    projectQueryCalls: 0,
    projectCollaboratorListCalls: [],
    myCollaboratorListCalls: [],
    mentionQueryCalls: [],
    adminCreateCalls: [],
    userSearchCalls: [],
    createCollabCalls: [],
    removeCollabCalls: [],
  };
  const connectCalls: any[] = [];
  const echoCalls: string[] = [];
  const program = new Command();
  const deps = makeDeps(capture);
  deps.connectConat = ((opts: any) => {
    connectCalls.push(opts);
    return {
      waitUntilReady: async () => {},
      subscribe: async (subject: string) => ({
        subject,
        close: () => {},
        async *[Symbol.asyncIterator]() {},
      }),
      call: (subject: string) => ({
        echo: async (payload: string) => {
          echoCalls.push(subject);
          return { ok: true, bytes: payload.length };
        },
      }),
      close: () => {},
    };
  }) as any;
  registerLoadCommand(program, deps);

  await program.parseAsync([
    "node",
    "test",
    "load",
    "conat-messages",
    "--addresses",
    "http://router-1:9102,http://router-2:9102",
    "--system-password",
    "secret",
    "--iterations",
    "4",
    "--warmup",
    "1",
    "--concurrency",
    "2",
    "--payload-bytes",
    "32",
    "--response-mode",
    "no-wait",
  ]);

  assert.equal(connectCalls.length, 4);
  assert.deepEqual(
    connectCalls.map((opts) => opts.address),
    [
      "http://router-1:9102",
      "http://router-2:9102",
      "http://router-1:9102",
      "http://router-2:9102",
    ],
  );
  assert.ok(
    connectCalls.every((opts) => opts.systemAccountPassword === "secret"),
  );
  assert.equal(echoCalls.length, 5);
  assert.equal(capture.data.scenario, "conat-messages");
  assert.equal(capture.data.iterations, 4);
  assert.equal(capture.data.warmup, 1);
  assert.equal(capture.data.concurrency, 2);
  assert.equal(capture.data.successes, 4);
  assert.equal(capture.data.failures, 0);
  assert.equal(capture.data.last_result.payload_bytes, 32);
  assert.equal(capture.data.last_result.request_transport, "pubsub");
  assert.equal(capture.data.last_result.response_mode, "no-wait");
  assert.equal(capture.data.last_result.response_bytes, 32);
});

test("load conat-messages measures direct Conat RPC calls", async () => {
  const capture: Capture = {
    accountBayCalls: 0,
    listBayCalls: 0,
    projectQueryCalls: 0,
    projectCollaboratorListCalls: [],
    myCollaboratorListCalls: [],
    mentionQueryCalls: [],
    adminCreateCalls: [],
    userSearchCalls: [],
    createCollabCalls: [],
    removeCollabCalls: [],
  };
  const rpcServices: string[] = [];
  const rpcCalls: string[] = [];
  const subscribeCalls: string[] = [];
  const program = new Command();
  const deps = makeDeps(capture);
  deps.connectConat = ((opts: any) => {
    return {
      waitUntilReady: async () => {},
      subscribe: async (subject: string) => {
        subscribeCalls.push(subject);
        return {
          subject,
          close: () => {},
          async *[Symbol.asyncIterator]() {},
        };
      },
      rpcService: async (subject: string) => {
        rpcServices.push(`${opts.address}:${subject}`);
        return {
          subject,
          close: () => {},
        };
      },
      rpcCall: (subject: string) => ({
        echo: async (payload: string) => {
          rpcCalls.push(`${opts.address}:${subject}`);
          return { ok: true, bytes: payload.length };
        },
      }),
      close: () => {},
    };
  }) as any;
  registerLoadCommand(program, deps);

  await program.parseAsync([
    "node",
    "test",
    "load",
    "conat-messages",
    "--addresses",
    "http://router-1:9102,http://router-2:9102",
    "--system-password",
    "secret",
    "--iterations",
    "4",
    "--warmup",
    "1",
    "--concurrency",
    "2",
    "--payload-bytes",
    "32",
    "--request-transport",
    "rpc",
  ]);

  assert.equal(rpcServices.length, 2);
  assert.match(
    rpcServices[0],
    /^http:\/\/router-1:9102:load\.conat_messages\./,
  );
  assert.match(
    rpcServices[1],
    /^http:\/\/router-2:9102:load\.conat_messages\./,
  );
  assert.equal(rpcCalls.length, 5);
  assert.equal(rpcCalls[0], rpcServices[0]);
  assert.equal(rpcCalls[1], rpcServices[1]);
  assert.deepEqual(subscribeCalls, []);
  assert.equal(capture.data.successes, 4);
  assert.equal(capture.data.failures, 0);
  assert.equal(capture.data.last_result.payload_bytes, 32);
  assert.equal(capture.data.last_result.request_transport, "rpc");
  assert.equal(capture.data.last_result.response_bytes, 32);
});

test("load bootstrap summarizes repeated control-plane calls", async () => {
  const capture: Capture = {
    accountBayCalls: 0,
    listBayCalls: 0,
    projectQueryCalls: 0,
    projectCollaboratorListCalls: [],
    myCollaboratorListCalls: [],
    mentionQueryCalls: [],
    adminCreateCalls: [],
    userSearchCalls: [],
    createCollabCalls: [],
    removeCollabCalls: [],
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
    mentionQueryCalls: [],
    adminCreateCalls: [],
    userSearchCalls: [],
    createCollabCalls: [],
    removeCollabCalls: [],
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
    mentionQueryCalls: [],
    adminCreateCalls: [],
    userSearchCalls: [],
    createCollabCalls: [],
    removeCollabCalls: [],
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
    mentionQueryCalls: [],
    adminCreateCalls: [],
    userSearchCalls: [],
    createCollabCalls: [],
    removeCollabCalls: [],
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

test("load mentions respects the requested limit", async () => {
  const capture: Capture = {
    accountBayCalls: 0,
    listBayCalls: 0,
    projectQueryCalls: 0,
    projectCollaboratorListCalls: [],
    myCollaboratorListCalls: [],
    mentionQueryCalls: [],
    adminCreateCalls: [],
    userSearchCalls: [],
    createCollabCalls: [],
    removeCollabCalls: [],
  };
  const program = new Command();
  registerLoadCommand(program, makeDeps(capture));

  await program.parseAsync([
    "node",
    "test",
    "load",
    "mentions",
    "--iterations",
    "2",
    "--warmup",
    "1",
    "--concurrency",
    "4",
    "--limit",
    "25",
  ]);

  assert.deepEqual(capture.mentionQueryCalls, [25, 25, 25]);
  assert.equal(capture.data.scenario, "mentions");
  assert.equal(capture.data.iterations, 2);
  assert.equal(capture.data.warmup, 1);
  assert.equal(capture.data.concurrency, 3);
  assert.equal(capture.data.successes, 2);
  assert.equal(capture.data.failures, 0);
  assert.equal(capture.data.last_result.mention_count, 2);
  assert.equal(capture.data.last_result.first_project_id, "mention-project-1");
  assert.equal(capture.data.last_result.first_path, "notes/chat.sage-chat");
  assert.equal(capture.data.last_result.first_target, "target-1");
});

test("load three-bay measures the canonical split control-plane path", async () => {
  const capture: Capture = {
    accountBayCalls: 0,
    listBayCalls: 0,
    projectBayCalls: [],
    hostBayCalls: [],
    bayOpsOverviewCalls: 0,
    bayOpsDetailCalls: [],
    projectQueryCalls: 0,
    projectCollaboratorListCalls: [],
    myCollaboratorListCalls: [],
    mentionQueryCalls: [],
    adminCreateCalls: [],
    userSearchCalls: [],
    createCollabCalls: [],
    removeCollabCalls: [],
  };
  const program = new Command();
  registerLoadCommand(program, makeDeps(capture));

  await program.parseAsync([
    "node",
    "test",
    "load",
    "three-bay",
    "--project",
    "demo",
    "--iterations",
    "2",
    "--warmup",
    "1",
    "--concurrency",
    "2",
    "--project-limit",
    "10",
    "--detail-bays",
    "bay-0,bay-1,bay-2",
  ]);

  assert.equal(capture.accountBayCalls, 3);
  assert.equal(capture.projectQueryCalls, 3);
  assert.equal(capture.lastLimit, 10);
  assert.deepEqual(capture.projectBayCalls, [
    "project-demo",
    "project-demo",
    "project-demo",
  ]);
  assert.deepEqual(capture.hostBayCalls, ["host-2", "host-2", "host-2"]);
  assert.equal(capture.bayOpsOverviewCalls, 3);
  assert.deepEqual(capture.bayOpsDetailCalls, [
    "bay-0",
    "bay-1",
    "bay-2",
    "bay-0",
    "bay-1",
    "bay-2",
    "bay-0",
    "bay-1",
    "bay-2",
  ]);
  assert.equal(capture.data.scenario, "three-bay-control-plane");
  assert.equal(capture.data.iterations, 2);
  assert.equal(capture.data.warmup, 1);
  assert.equal(capture.data.concurrency, 2);
  assert.equal(capture.data.successes, 2);
  assert.equal(capture.data.failures, 0);
  assert.equal(capture.data.last_result.account_home_bay_id, "bay-0");
  assert.equal(capture.data.last_result.project_owning_bay_id, "bay-1");
  assert.equal(capture.data.last_result.host_bay_id, "bay-2");
  assert.equal(capture.data.last_result.detail_bay_count, 3);
  assert.ok(capture.data.component_latency_ms["account-home-bay"].samples > 0);
  assert.ok(capture.data.component_latency_ms["bay-ops-detail"].samples > 0);
});

test("load three-bay hot-path skips Bay Ops probes", async () => {
  const capture: Capture = {
    accountBayCalls: 0,
    listBayCalls: 0,
    projectBayCalls: [],
    hostBayCalls: [],
    bayOpsOverviewCalls: 0,
    bayOpsDetailCalls: [],
    projectQueryCalls: 0,
    projectCollaboratorListCalls: [],
    myCollaboratorListCalls: [],
    mentionQueryCalls: [],
    adminCreateCalls: [],
    userSearchCalls: [],
    createCollabCalls: [],
    removeCollabCalls: [],
  };
  const program = new Command();
  registerLoadCommand(program, makeDeps(capture));

  await program.parseAsync([
    "node",
    "test",
    "load",
    "three-bay",
    "--project",
    "demo",
    "--iterations",
    "2",
    "--warmup",
    "1",
    "--concurrency",
    "2",
    "--hot-path",
  ]);

  assert.equal(capture.accountBayCalls, 3);
  assert.equal(capture.projectQueryCalls, 0);
  assert.deepEqual(capture.projectBayCalls, [
    "project-demo",
    "project-demo",
    "project-demo",
  ]);
  assert.deepEqual(capture.hostBayCalls, ["host-2", "host-2", "host-2"]);
  assert.deepEqual(capture.projectCollaboratorListCalls, []);
  assert.equal(capture.bayOpsOverviewCalls, 0);
  assert.deepEqual(capture.bayOpsDetailCalls, []);
  assert.equal(capture.data.last_result.hot_path, true);
  assert.equal(capture.data.last_result.bay_ops_overview_enabled, false);
  assert.equal(capture.data.last_result.visible_bay_count, null);
  assert.equal(capture.data.last_result.detail_bay_count, 0);
  assert.equal(
    capture.data.component_latency_ms["bay-ops-overview"],
    undefined,
  );
  assert.equal(capture.data.component_latency_ms["bay-ops-detail"], undefined);
});

test("load three-bay batched hot-path uses one routing RPC per sample", async () => {
  const capture: Capture = {
    accountBayCalls: 0,
    listBayCalls: 0,
    projectBayCalls: [],
    hostBayCalls: [],
    routingContextCalls: [],
    bayOpsOverviewCalls: 0,
    bayOpsDetailCalls: [],
    projectQueryCalls: 0,
    projectCollaboratorListCalls: [],
    myCollaboratorListCalls: [],
    mentionQueryCalls: [],
    adminCreateCalls: [],
    userSearchCalls: [],
    createCollabCalls: [],
    removeCollabCalls: [],
  };
  const program = new Command();
  registerLoadCommand(program, makeDeps(capture));

  await program.parseAsync([
    "node",
    "test",
    "load",
    "three-bay",
    "--project",
    "demo",
    "--iterations",
    "2",
    "--warmup",
    "1",
    "--concurrency",
    "2",
    "--hot-path",
    "--batched-routing",
  ]);

  assert.equal(capture.accountBayCalls, 0);
  assert.equal(capture.projectQueryCalls, 0);
  assert.deepEqual(capture.projectBayCalls, []);
  assert.deepEqual(capture.hostBayCalls, []);
  assert.deepEqual(capture.routingContextCalls, [
    {
      project_id: "project-demo",
      host_id: "host-2",
      user_account_id: "11111111-1111-4111-8111-111111111111",
    },
    {
      project_id: "project-demo",
      host_id: "host-2",
      user_account_id: "11111111-1111-4111-8111-111111111111",
    },
    {
      project_id: "project-demo",
      host_id: "host-2",
      user_account_id: "11111111-1111-4111-8111-111111111111",
    },
  ]);
  assert.equal(capture.data.last_result.hot_path, true);
  assert.equal(capture.data.last_result.account_home_bay_id, "bay-0");
  assert.equal(capture.data.last_result.project_owning_bay_id, "bay-1");
  assert.equal(capture.data.last_result.host_bay_id, "bay-2");
  assert.ok(capture.data.component_latency_ms["routing-context"].samples > 0);
  assert.equal(
    capture.data.component_latency_ms["account-home-bay"],
    undefined,
  );
});

test("load three-bay duration mode reports sustained measured attempts", async () => {
  const capture: Capture = {
    accountBayCalls: 0,
    listBayCalls: 0,
    projectBayCalls: [],
    hostBayCalls: [],
    bayOpsOverviewCalls: 0,
    bayOpsDetailCalls: [],
    projectQueryCalls: 0,
    projectCollaboratorListCalls: [],
    myCollaboratorListCalls: [],
    mentionQueryCalls: [],
    adminCreateCalls: [],
    userSearchCalls: [],
    createCollabCalls: [],
    removeCollabCalls: [],
  };
  const program = new Command();
  registerLoadCommand(program, makeDeps(capture));

  await program.parseAsync([
    "node",
    "test",
    "load",
    "three-bay",
    "--project",
    "demo",
    "--duration",
    "1ms",
    "--warmup",
    "1",
    "--concurrency",
    "2",
    "--hot-path",
  ]);

  assert.equal(capture.data.duration_ms, 1);
  assert.equal(capture.data.concurrency, 2);
  assert.equal(capture.data.failures, 0);
  assert.ok(capture.data.successes > 0);
  assert.equal(capture.data.iterations, capture.data.successes);
  assert.ok(capture.accountBayCalls >= capture.data.successes + 1);
});

test("load collaborator-cycle uses a seeded per-worker account pool", async () => {
  const capture: Capture = {
    accountBayCalls: 0,
    listBayCalls: 0,
    projectQueryCalls: 0,
    projectCollaboratorListCalls: [],
    myCollaboratorListCalls: [],
    mentionQueryCalls: [],
    adminCreateCalls: [],
    userSearchCalls: [],
    createCollabCalls: [],
    removeCollabCalls: [],
  };
  const program = new Command();
  registerLoadCommand(program, makeDeps(capture));

  await program.parseAsync([
    "node",
    "test",
    "load",
    "collaborator-cycle",
    "--project",
    "demo",
    "--prefix",
    "cycle",
    "--count",
    "4",
    "--iterations",
    "4",
    "--warmup",
    "1",
    "--concurrency",
    "2",
  ]);

  assert.deepEqual(capture.userSearchCalls, [
    "cycle-0001@load.test",
    "cycle-0002@load.test",
    "cycle-0003@load.test",
    "cycle-0004@load.test",
  ]);
  assert.equal(capture.removeCollabCalls.length, 5);
  assert.equal(capture.createCollabCalls.length, 9);
  const removeAccounts = new Set(
    capture.removeCollabCalls.map((row) => row.account_id),
  );
  assert.deepEqual(
    removeAccounts,
    new Set(["existing-cycle-0001", "existing-cycle-0002"]),
  );
  assert.equal(capture.data.scenario, "collaborator-cycle");
  assert.equal(capture.data.iterations, 4);
  assert.equal(capture.data.warmup, 1);
  assert.equal(capture.data.concurrency, 2);
  assert.equal(capture.data.successes, 4);
  assert.equal(capture.data.failures, 0);
  assert.equal(capture.data.last_result.project_id, "project-demo");
  assert.equal(capture.data.last_result.operation, "remove-then-direct-add");
});

test("load seed users creates or reuses accounts and adds collaborators", async () => {
  const capture: Capture = {
    accountBayCalls: 0,
    listBayCalls: 0,
    projectQueryCalls: 0,
    projectCollaboratorListCalls: [],
    myCollaboratorListCalls: [],
    mentionQueryCalls: [],
    adminCreateCalls: [],
    userSearchCalls: [],
    createCollabCalls: [],
    removeCollabCalls: [],
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
