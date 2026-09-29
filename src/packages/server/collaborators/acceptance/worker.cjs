/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
// A separate Node process is essential: pool, bay identity and host SQLite are
// module globals. This fixture loads normal workspace outputs, without mocks.
const { createServer } = require("node:http");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { join } = require("node:path");
// Server intentionally does not depend on project-host. Resolve the standalone
// host fixture against that package's own dependency graph, without a new dep.
const hostRequire = require("node:module").createRequire(
  join(__dirname, "../../../project-host/package.json"),
);

let config, pool, fabric, human, hostClient, hostService, journalService;
const closeables = [];
const counters = { starts: 0, ownerCalls: {}, hubCalls: {}, rehomeCalls: {} };
let closing;
let dropSendReply;
let interruptAccountCopy = false;
let scanProjectLock;
const droppedReplies = [];

// Fault at the real service's response boundary, after its unmodified handler
// has saved the chat. Authentication, request transport and persistence stay
// production code; only this one successful reply is deliberately not sent.
function faultableRoomClient(client) {
  return new Proxy(client, {
    get(target, key) {
      if (key === "service")
        return (subject, impl, opts) =>
          target.service(
            subject,
            {
              ...impl,
              async send(...args) {
                const result = await impl.send.apply(this, args);
                if (args[0]?.request_id === dropSendReply) {
                  droppedReplies.push({ request_id: dropSendReply, result });
                  dropSendReply = undefined;
                  this.respond = async () => undefined;
                }
                return result;
              },
            },
            opts,
          );
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function own(value) {
  closeables.push(value);
  return value;
}
function count(map, name) {
  map[name] = (map[name] ?? 0) + 1;
}
async function connect(address, options) {
  const client = own(
    require("@cocalc/conat/core/client").connect({
      address,
      noCache: true,
      ...options,
    }),
  );
  await client.waitUntilSignedIn({ timeout: 10000 });
  return client;
}
async function socketServer(auth) {
  const httpServer = createServer();
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  own({ close: () => new Promise((resolve) => httpServer.close(resolve)) });
  const server = own(
    require("@cocalc/conat/core/server").init({
      httpServer,
      port: httpServer.address().port,
      path: "/",
      autoscanInterval: 0,
      ...auth,
    }),
  );
  if (server.state !== "ready")
    await require("node:events").once(server, "ready", {
      signal: AbortSignal.timeout(15000),
    });
  return `http://127.0.0.1:${httpServer.address().port}`;
}
function users(group = "collaborator") {
  return {
    [config.accounts[0]]: { group: "owner" },
    ...(group ? { [config.accounts[1]]: { group } } : {}),
  };
}
async function bootstrapDb() {
  if (!/^collab_acceptance_[a-f0-9]+_(owner|a|b)$/.test(process.env.PGDATABASE))
    throw Error("acceptance worker requires its isolated database");
  pool = require("@cocalc/database/pool").default({ ensureExists: false });
  await require("@cocalc/database/postgres/schema").syncSchema();
  await require("@cocalc/database/postgres/collaborators/collaborators-common").syncCollaboratorsSchema();
  await require("@cocalc/database/postgres/collaborators/collaborators-notifications").ensureCollaborationNotificationSchema();
  await pool.query(
    "INSERT INTO server_settings(name,value) VALUES('collaborators_enabled','yes') ON CONFLICT(name) DO UPDATE SET value='yes'",
  );
  const indexes =
    config.role === "owner" ? [0, 1] : [config.role === "a" ? 0 : 1];
  for (const i of indexes)
    await pool.query(
      "INSERT INTO accounts(account_id,home_bay_id,first_name,last_name) VALUES($1,$2,$3,'Acceptance')",
      [config.accounts[i], config.bays[i + 1], i ? "Bob" : "Alice"],
    );
  if (config.role === "owner") {
    await pool.query(
      "INSERT INTO projects(project_id,host_id,owning_bay_id,users,state,title) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,'Stopped acceptance project')",
      [
        config.project,
        config.host,
        config.bays[0],
        JSON.stringify(users()),
        JSON.stringify({ state: "opened" }),
      ],
    );
  } else {
    const account = config.accounts[config.role === "a" ? 0 : 1];
    await pool.query(
      "INSERT INTO account_project_index(account_id,project_id,owning_bay_id,users_summary,title,sort_key) VALUES($1,$2,$3,$4::jsonb,'Stopped acceptance project',now())",
      [account, config.project, config.bays[0], JSON.stringify(users())],
    );
  }
}

async function startOwner() {
  const auth = require("@cocalc/server/conat/socketio/auth");
  const credentials = require("@cocalc/server/inter-bay/bay-credentials");
  const tokens = new Map([
    [config.accountSecrets[0], { account_id: config.accounts[0] }],
    [config.accountSecrets[1], { account_id: config.accounts[1] }],
    [config.hostSecret, { host_id: config.host }],
  ]);
  // Only credential issuance is substituted. Caller IDs never come from the
  // payload/handshake; production authorization remains on every subject.
  const address = await socketServer({
    getUser: async (socket, systemAccounts) => {
      const token = socket.handshake.auth?.acceptanceCredential;
      if (token !== undefined) {
        const identity = tokens.get(token);
        if (!identity) throw Error("invalid acceptance credential");
        return { ...identity };
      }
      return auth.getUser(socket, systemAccounts);
    },
    isAllowed: auth.isAllowed,
    systemAccountPassword: config.systemSecret,
  });
  const issued = [];
  for (const bay_id of config.bays)
    issued.push((await credentials.issueBayCredential({ bay_id })).credential);
  config.address = address;
  config.bayCredential = issued[0];
  await configureFabric();
  const { createServiceHandler } = require("@cocalc/conat/service/typed");
  const api = require("@cocalc/conat/inter-bay/api");
  const registry = require("@cocalc/server/bay-registry");
  for (const bay_id of config.bays)
    await registry.registerBayPresenceLocal({
      bay_id,
      role: bay_id === config.bays[0] ? "seed" : "attached",
    });
  own(
    createServiceHandler({
      client: fabric,
      service: "inter-bay-bay-registry",
      transport: "request",
      subject: api.bayRegistrySubject({ method: "list" }),
      impl: { list: () => registry.listBayRegistryLocal() },
    }),
  );
  const accountDirectory = require("@cocalc/server/accounts/cluster-directory");
  await accountDirectory.ensureClusterAccountDirectorySchema();
  for (let i = 0; i < config.accounts.length; i++)
    await pool.query(
      "INSERT INTO cluster_account_directory(account_id,email_address,home_bay_id) VALUES($1,$2,$3)",
      [
        config.accounts[i],
        `${config.accounts[i]}@acceptance.invalid`,
        config.bays[i + 1],
      ],
    );
  for (const [method, name, fn] of [
    [
      "get-many",
      "getMany",
      ({ account_ids }) =>
        accountDirectory.getClusterAccountsByIdsDirect(account_ids),
    ],
    [
      "update-home-bay",
      "updateHomeBay",
      accountDirectory.updateClusterAccountHomeBayDirect,
    ],
    [
      "update-api-keys-home-bay",
      "updateApiKeysHomeBay",
      accountDirectory.updateClusterAccountApiKeysHomeBayDirect,
    ],
  ])
    own(
      createServiceHandler({
        client: fabric,
        service: "inter-bay-account-directory",
        transport: "request",
        subject: api.accountDirectorySubject({ method }),
        impl: { [name]: fn },
      }),
    );
  const directory = require("@cocalc/server/inter-bay/directory");
  for (const [suffix, method, fn, key] of [
    [
      "resolve-project-bay",
      "resolveProjectBay",
      directory.resolveProjectBayDirect,
      "project_id",
    ],
    [
      "resolve-host-bay",
      "resolveHostBay",
      directory.resolveHostBayDirect,
      "host_id",
    ],
  ])
    own(
      createServiceHandler({
        client: fabric,
        service: "inter-bay-directory",
        transport: "request",
        subject: `global.directory.rpc.${suffix}`,
        impl: { [method]: (opts) => fn(opts[key]) },
      }),
    );
  own(
    createServiceHandler({
      client: fabric,
      service: "inter-bay-account-directory",
      transport: "request",
      subject: "global.account-directory.rpc.get",
      impl: {
        get: ({ account_id }) =>
          require("@cocalc/server/accounts/cluster-directory").getClusterAccountByIdDirect(
            account_id,
          ),
      },
    }),
  );
  const internal = await connect(address, {
    systemAccountPassword: config.systemSecret,
  });
  own(require("@cocalc/backend/conat/persist").server({ client: internal }));
  await startBayApi([`hub.host.${config.host}.api`]);
  return { address, credentials: issued, pid: process.pid };
}
async function configureFabric() {
  process.env.COCALC_INTER_BAY_CONAT_SERVER = config.address;
  process.env.COCALC_CLUSTER_SEED_CONAT_SERVER = config.address;
  process.env.COCALC_BAY_CREDENTIAL = config.bayCredential;
  const data = require("@cocalc/backend/data");
  data.setConatServer(config.address);
  data.setConatPassword(config.systemSecret);
  fabric = own(
    require("@cocalc/server/inter-bay/fabric").getInterBayFabricClient({
      noCache: true,
    }),
  );
  await fabric.waitUntilSignedIn({ timeout: 10000 });
}
async function startBayApi(subjects) {
  // Register the same typed private endpoints as server/inter-bay/service.ts.
  // These use real bay credentials, not the human hub or a fixture network API.
  const api = require("@cocalc/conat/inter-bay/api");
  const rehome = require("@cocalc/server/accounts/rehome");
  const { createServiceHandler } = require("@cocalc/conat/service/typed");
  const bay_id = process.env.COCALC_BAY_ID;
  own(
    createServiceHandler({
      client: fabric,
      service: "inter-bay-directory",
      transport: "request",
      parallel: true,
      subject: api.bayDirectorySubject({
        dest_bay: bay_id,
        method: "resolve-project-bay",
      }),
      impl: {
        resolveProjectBay: ({ project_id }) =>
          require("@cocalc/server/inter-bay/directory").resolveProjectBayDirect(
            project_id,
          ),
      },
    }),
  );
  const projectControl = require("@cocalc/server/inter-bay/project-control");
  for (const [factory, name, fn] of [
    [
      api.createInterBayProjectControlRehomeHandler,
      "rehome",
      projectControl.handleProjectControlRehome,
    ],
    [
      api.createInterBayProjectControlAcceptRehomeHandler,
      "acceptRehome",
      projectControl.handleProjectControlAcceptRehome,
    ],
    [
      api.createInterBayProjectControlCollaborationRehomeHandler,
      "collaborationRehome",
      projectControl.handleProjectControlCollaborationRehome,
    ],
  ])
    own(
      factory({
        client: fabric,
        bay_id,
        parallel: true,
        impl: {
          [name]: (opts) => {
            count(
              counters.rehomeCalls,
              `project.${name}${opts.action ? "." + opts.action : ""}`,
            );
            return fn(opts);
          },
        },
      }),
    );
  const feed = require("@cocalc/server/account/project-feed");
  for (const service of api.createInterBayAccountProjectFeedHandlers({
    client: fabric,
    bay_id,
    parallel: true,
    impl: {
      upsert: feed.applyAccountProjectFeedUpsertOnHomeBay,
      remove: feed.applyAccountProjectFeedRemoveOnHomeBay,
    },
  }))
    own(service);
  for (const [method, name, fn] of [
    ["rehome", "rehome", rehome.rehomeAccountOnHomeBay],
    ["accept-rehome", "acceptRehome", rehome.acceptAccountRehome],
    ["copy-rehome-state", "copyRehomeState", rehome.copyAccountRehomeState],
    [
      "get-rehome-operation",
      "getRehomeOperation",
      ({ op_id }) => rehome.getAccountRehomeOperation(op_id),
    ],
    [
      "reconcile-rehome",
      "reconcileRehome",
      rehome.reconcileAccountRehomeOnSource,
    ],
  ])
    own(
      createServiceHandler({
        client: fabric,
        service: "inter-bay-account-local",
        transport: "request",
        parallel: true,
        subject: api.accountLocalSubject({
          dest_bay: process.env.COCALC_BAY_ID,
          method,
        }),
        impl: {
          [name]: async (opts) => {
            count(counters.rehomeCalls, name);
            const result = await fn(opts);
            if (
              name === "copyRehomeState" &&
              opts.collaboration_page &&
              interruptAccountCopy
            ) {
              interruptAccountCopy = false;
              throw Error(
                "fixture interrupted account copy after durable page receipt",
              );
            }
            return result;
          },
        },
      }),
    );
  const { collaboratorsControl } = require("@cocalc/server/collaborators/api");
  const impl = new Proxy(collaboratorsControl, {
    get(target, name) {
      const f = target[name];
      if (typeof f !== "function") return f;
      return (...args) => {
        count(counters.ownerCalls, name);
        return f(...args);
      };
    },
  });
  own(
    require("@cocalc/conat/inter-bay/collaborators").createInterBayCollaboratorsHandler(
      {
        client: fabric,
        bay_id: process.env.COCALC_BAY_ID,
        impl,
        parallel: true,
      },
    ),
  );
  const { handleApiRequest } = require("@cocalc/server/conat/api");
  for (const subject of subjects) {
    const sub = own(await fabric.subscribe(subject));
    void (async () => {
      for await (const mesg of sub) {
        const request = mesg.data;
        count(counters.hubCalls, request.name);
        if (/\.(start|startFromHost|restart)$/.test(request.name)) {
          counters.starts++;
          await mesg.respond(null, {
            headers: { error: "compute start forbidden in acceptance fixture" },
          });
        } else {
          await handleApiRequest({ request, mesg });
        }
      }
    })().catch((err) => {
      if (!closing) process.send?.({ fatal: String(err) });
    });
  }
}
async function startHome() {
  await configureFabric();
  // Initialize each home's independent on-disk persist portability context.
  // Favorites traffic remains on the seed broker in this minimal fixture.
  require("@cocalc/backend/conat/persist");
  const i = config.role === "a" ? 0 : 1;
  await startBayApi([`hub.account.${config.accounts[i]}.api`]);
  human = await connect(config.address, {
    inboxPrefix: `_INBOX.account-${config.accounts[i]}`,
    auth: { acceptanceCredential: config.accountSecrets[i] },
  });
  return { pid: process.pid };
}
async function startHost() {
  const data = require("@cocalc/backend/data");
  data.setConatPassword(config.hostSystemSecret);
  const sqlite = hostRequire("@cocalc/lite/hub/sqlite/database");
  sqlite.initDatabase({ filename: join(config.directory, "host.sqlite") });
  sqlite.upsertRow("project-host", "host-id", { hostId: config.host });
  const projects = hostRequire("@cocalc/project-host/sqlite/projects");
  if (!projects.getProject(config.project)) {
    projects.upsertProject({
      project_id: config.project,
      state: "opened",
      users: users(),
      local_only: false,
    });
    sqlite.upsertRow(
      "projects",
      JSON.stringify({ project_id: config.project }),
      {
        project_id: config.project,
        users: users(),
      },
    );
  }
  const auth = hostRequire(
    "@cocalc/project-host/conat-auth",
  ).createProjectHostConatAuth({ host_id: config.host });
  const address = await socketServer({
    ...auth,
    systemAccountPassword: config.hostSystemSecret,
  });
  data.setConatServer(address);
  const internal = await connect(address, {
    systemAccountPassword: config.hostSystemSecret,
  });
  require("@cocalc/conat/client").setConatClient({
    conat: () => internal,
    getLogger: require("@cocalc/backend/logger").getLogger,
  });
  own(require("@cocalc/backend/conat/persist").server({ client: internal }));
  const master = await connect(config.address, {
    inboxPrefix: `_INBOX.host-${config.host}`,
    auth: { acceptanceCredential: config.hostSecret },
  });
  hostRequire("@cocalc/project-host/master-conat-client").setMasterConatClient(
    master,
  );
  const home = join(config.directory, "volume");
  const rootfs = join(config.directory, "rootfs");
  await mkdir(home, { recursive: true });
  await mkdir(rootfs, { recursive: true });
  const { SandboxedFilesystem } = require("@cocalc/backend/sandbox");
  const fsOptions = {
    rootfs,
    homeAliases: ["/home/user"],
    disableOpenAt2: true,
  };
  const getFilesystem = async (project_id) => {
    if (project_id !== config.project) throw Error("unknown fixture volume");
    return new SandboxedFilesystem(home, fsOptions);
  };
  const collaborators = hostRequire("@cocalc/project-host/collaborators");
  journalService = collaborators.startCollaborators(getFilesystem);
  own(
    await require("@cocalc/backend/conat/files/local-path").localPathFileserver(
      {
        client: internal,
        project_id: config.project,
        path: home,
        ...fsOptions,
        wrapFilesystem: (fs, project_id) =>
          collaborators.withCollaborators(fs, project_id),
        jupyter: {
          importIpynb: async () => {
            throw Error("not a notebook fixture");
          },
          saveIpynb: async () => {
            throw Error("not a notebook fixture");
          },
        },
      },
    ),
  );
  const hub = async (name, opts) =>
    require("@cocalc/conat/hub/call-hub").default({
      client: master,
      host_id: config.host,
      name,
      args: [opts],
    });
  hostService = own(
    await hostRequire(
      "@cocalc/project-host/collaborators-service",
    ).initCollaboratorsService(faultableRoomClient(internal), {
      resolveRoom: ({ project_id, account_id }) =>
        hub("collaborators.roomForHost", {
          project_id,
          requesting_account_id: account_id,
        }),
      markInitialized: (room, { account_id }) =>
        hub("collaborators.markRoomInitialized", {
          ...room,
          requesting_account_id: account_id,
        }),
    }),
  );
  return { address, pid: process.pid };
}

// Parent IPC only: seed one bounded historical fixture in this runner's volume.
// The production migration/indexing worker, not this helper, assigns identities.
async function historicalFixture(args) {
  if (config.role !== "host") throw Error("historical fixture requires host");
  const source = {
    project_id: config.project,
    chat_path: "/home/user/historical-acceptance.chat",
  };
  const path = join(config.directory, "volume/historical-acceptance.chat");
  const archive = require("@cocalc/backend/chat-store/sqlite-offload");
  const digest = (rows) =>
    createHash("sha256")
      .update(
        JSON.stringify(
          rows
            .filter((row) => row.event === "chat")
            .sort((a, b) => a.date.localeCompare(b.date)),
        ),
      )
      .digest("hex");
  if (args.create) {
    const rootDate = "2026-09-01T00:00:00.000Z";
    const rows = Array.from({ length: 1000 }, (_, i) => {
      const sender_id =
        i === 0
          ? config.accounts[0]
          : i === 999
            ? config.accounts[1]
            : `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
      const date = new Date(Date.parse(rootDate) + i).toISOString();
      return {
        event: "chat",
        date,
        sender_id,
        ...(i ? { reply_to: rootDate } : {}),
        history: [
          {
            author_id: sender_id,
            date,
            content: i ? `Historical message ${i}` : args.reference,
          },
        ],
      };
    });
    const write = journalService.journal.beginWrite(source);
    try {
      await writeFile(
        path,
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
        { flag: "wx" },
      );
      const result = await archive.rotateChatStore({
        chat_path: path,
        keep_recent_messages: 1,
        force: true,
      });
      if (!result.rotated) throw Error("historical fixture did not archive");
      return { ...source, digest: digest(rows), originalMessages: rows.length };
    } finally {
      journalService.journal.finishWrite(write);
    }
  }
  const head = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const archived = archive.readChatIdentityArchive({ chat_path: path });
  const {
    resolveChatIdentityRows,
  } = require("@cocalc/util/collaboration-chat-identity");
  const resolved = resolveChatIdentityRows([...head, ...archived]);
  return {
    ...source,
    digest: digest([...head, ...archived]),
    headMessages: head.filter((row) => row.event === "chat").length,
    archivedMessages: archived.filter((row) => row.event === "chat").length,
    threadIds: [...new Set(resolved.messages.map((row) => row.thread_id))],
    messageIds: resolved.messages.map((row) => row.message_id).sort(),
  };
}

async function command(name, args = {}) {
  switch (name) {
    case "boot":
      config = args;
      if (config.role === "host") return startHost();
      await bootstrapDb();
      return config.role === "owner" ? startOwner() : startHome();
    case "hub":
      return require("@cocalc/conat/hub/call-hub").default({
        client: human,
        account_id:
          args.account_id ?? config.accounts[config.role === "a" ? 0 : 1],
        name: args.name,
        args: [args.opts ?? {}],
        timeout: 10000,
      });
    case "host": {
      if (!hostClient)
        hostClient = await connect(args.address, {
          inboxPrefix: `_INBOX.account-${config.accounts[config.role === "a" ? 0 : 1]}`,
          auth: { bearer: args.token },
        });
      const account_id =
        args.account_id ?? config.accounts[config.role === "a" ? 0 : 1];
      return hostClient
        .call(
          `services.account-${account_id}.acceptance.${config.project}.0.collaborators`,
          { timeout: args.timeout ?? 10000 },
        )
        [args.method](args.opts);
    }
    case "dropSendReply":
      if (config.role !== "host" || dropSendReply)
        throw Error("only the host can arm one outstanding reply fault");
      dropSendReply = args.request_id;
      return null;
    case "historicalFixture":
      return historicalFixture(args);
    case "resetHostConnection":
      await hostClient?.close();
      hostClient = undefined;
      return null;
    case "interruptAccountCopy":
      interruptAccountCopy = true;
      return null;
    case "accountRehome": {
      const api =
        require("@cocalc/conat/inter-bay/api").createInterBayAccountLocalClient(
          {
            client: fabric,
            dest_bay: args.source_bay_id,
            timeout: 20000,
          },
        );
      return args.op_id
        ? api.reconcileRehome({ op_id: args.op_id })
        : api.rehome({
            account_id: config.accounts[0],
            target_account_id: config.accounts[0],
            dest_bay_id: args.dest_bay_id,
            reason: "isolated transport acceptance",
          });
    }
    case "projectRehome":
      return require("@cocalc/conat/inter-bay/api")
        .createInterBayProjectControlClient({
          client: fabric,
          dest_bay: args.source_bay_id,
          timeout: 25000,
        })
        .rehome({
          project_id: config.project,
          account_id: config.accounts[0],
          dest_bay_id: args.dest_bay_id,
          reason: "isolated owner transport acceptance",
        });
    case "privatePersonalWrite":
      return require("@cocalc/conat/inter-bay/collaborators")
        .createInterBayCollaboratorsClient({
          client: fabric,
          bay_id: args.bay_id,
          timeout: 5000,
        })
        .setPersonalState({ ...args.opts, route: { bay_id: args.bay_id } });
    case "privateOwnerRequest": {
      if (!["ownedResource", "registerSource"].includes(args.method))
        throw Error("unsupported owner fence probe");
      const api =
        require("@cocalc/conat/inter-bay/collaborators").createInterBayCollaboratorsClient(
          {
            client: fabric,
            bay_id: args.bay_id,
            timeout: 5000,
          },
        );
      return api[args.method]({ ...args.opts, route: { bay_id: args.bay_id } });
    }
    case "raw":
      return (await human.request(args.subject, args.data, { timeout: 2000 }))
        .data;
    case "sql":
      return (await pool.query(args.sql, args.params)).rows;
    case "indexingSeed": {
      const projection = require("@cocalc/database/postgres/collaborators/collaborators-projection");
      return projection.seedCollaborationProjectionJobs(
        config.bays[config.role === "a" ? 1 : 2],
      );
    }
    case "indexingMetrics":
      return require("prom-client").register.getMetricsAsJSON();
    case "notificationTick":
      await pool.query(
        "UPDATE collaboration_notification_cursors SET due_at=now() WHERE project_id=$1",
        [config.project],
      );
      return require("@cocalc/server/notifications/collaboration-state").runCollaborationNotificationMaintenance(
        require("@cocalc/server/collaborators/api")
          .fetchCollaborationNotificationPage,
      );
    case "notificationFanout": {
      const fanout = require("@cocalc/database/postgres/collaborators/collaborators-notification-fanout");
      if (args.operation === "tick")
        return require("@cocalc/server/collaborators/maintenance").runCollaboratorsFanoutMaintenance();
      if (args.operation === "drain")
        return require("@cocalc/server/notifications/collaboration-fanout").deliverCollaborationNotificationFanout(
          {
            project_id: config.project,
            bay_id: config.bays[0],
            deliver: async (input) => {
              const receipt =
                await require("@cocalc/server/collaborators/api").deliverCollaborationNotificationObligation(
                  input,
                );
              if (args.lose_reply) throw Error("fixture lost delivery reply");
              return receipt;
            },
          },
        );
      if (args.operation === "deliver")
        return require("@cocalc/server/collaborators/api").deliverCollaborationNotificationObligation(
          {
            project_id: config.project,
            id: args.id,
            account_id: args.account_id,
            membership_epoch: args.membership_epoch,
          },
        );
      if (args.operation === "authorize")
        return require("@cocalc/server/collaborators/api").fetchCollaborationNotificationObligation(
          {
            project_id: config.project,
            id: args.id,
            account_id: args.account_id,
            membership_epoch: args.membership_epoch,
          },
        );
      if (args.operation === "enable") {
        process.env.COCALC_PEOPLE_EVENT_FANOUT_PROTOTYPE = "1";
        return null;
      }
      if (args.operation === "disable") {
        delete process.env.COCALC_PEOPLE_EVENT_FANOUT_PROTOTYPE;
        return null;
      }
      if (args.operation === "prune")
        return require("@cocalc/database/postgres/collaborators/collaborators-notifications").pruneCollaborationNotificationEvents(
          config.bays[0],
        );
      if (args.operation === "claim")
        return fanout.claimCollaborationNotificationRecipients({
          project_id: config.project,
          bay_id: args.bay_id ?? config.bays[0],
          limit: args.limit,
        });
      if (args.operation === "settle")
        return fanout.settleCollaborationNotificationRecipient({
          project_id: config.project,
          bay_id: args.bay_id ?? config.bays[0],
          id: args.id,
          claim_id: args.claim_id,
          outcome: args.outcome,
        });
      return require("@cocalc/database/postgres/collaborators/collaborators-notification-fanout").expandCollaborationNotificationEvent(
        {
          event_id: args.event_id,
          bay_id: args.bay_id ?? config.bays[0],
          limit: args.limit,
        },
      );
    }
    case "installRevisionInterest": {
      await require("@cocalc/database/postgres/collaborators/collaborators-revision-interest").syncCollaborationRevisionInterestSchema(
        pool,
      );
      process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE = "1";
      process.env.COCALC_PEOPLE_DEMAND_PROTOTYPE = "1";
      return true;
    }
    case "installRevisionReceiver": {
      await require("@cocalc/database/postgres/collaborators/collaborators-revision-receiver").syncCollaborationRevisionReceiverSchema(
        pool,
      );
      process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE = "1";
      process.env.COCALC_PEOPLE_DEMAND_PROTOTYPE = "1";
      return true;
    }
    case "registerRevisionReceiver": {
      const api =
        require("@cocalc/conat/inter-bay/collaborators").createInterBayCollaboratorsClient(
          { client: fabric, bay_id: config.bays[1] },
        );
      return api.registerRevisionReceiver({
        project_id: config.project,
        account_id: config.accounts[0],
        route: { bay_id: config.bays[1] },
      });
    }
    case "dispatchRevisionHint":
      return require("@cocalc/server/collaborators/revision-dispatch").dispatchCollaborationRevisionHint(
        args,
      );
    case "installRevisionOutbox":
      await require("@cocalc/database/postgres/collaborators/collaborators-revision-outbox").syncCollaborationRevisionOutboxSchema(
        pool,
      );
      process.env.COCALC_PEOPLE_REVISION_OUTBOX_PROTOTYPE = "1";
      return true;
    case "dispatchRevisionOutbox":
    case "claimActiveProjection":
    case "applyActiveProjection":
    case "scheduleRevisionWakeups":
    case "repairRevisionHints": {
      const flags = [
        "COCALC_PEOPLE_DEMAND_SCHEDULER_PROTOTYPE",
        "COCALC_PEOPLE_EVENT_FANOUT_PROTOTYPE",
      ];
      const previous = flags.map((name) => process.env[name]);
      try {
        flags.forEach((name) => (process.env[name] = "1"));
        if (name === "dispatchRevisionOutbox")
          return await require("@cocalc/server/collaborators/revision-outbox").dispatchRevisionOutboxPage(
            config.project,
          );
        if (name === "claimActiveProjection")
          return await require("@cocalc/database/postgres/collaborators/collaborators-projection").claimCollaborationProjectionJobs(
            config.bays[config.role === "a" ? 1 : 2],
          );
        if (name === "applyActiveProjection") {
          const projection = require("@cocalc/database/postgres/collaborators/collaborators-projection");
          const jobs = await projection.claimCollaborationProjectionJobs(
            config.bays[config.role === "a" ? 1 : 2],
          );
          const requestedAt = Date.now();
          const fetchPage =
            require("@cocalc/server/collaborators/projection-batch").createSharedProjectionFetcher(
              jobs,
              require("@cocalc/server/collaborators/api")
                .fetchCollaborationSharedProjection,
            );
          return await Promise.all(
            jobs.map(async (job) => ({
              project_id: job.project_id,
              applied: await projection.applyCollaborationProjection(
                job,
                await fetchPage(job),
                requestedAt,
              ),
            })),
          );
        }
        if (name === "scheduleRevisionWakeups")
          return await require("@cocalc/server/collaborators/revision-wakeup").runRevisionWakeupScheduling();
        return await require("@cocalc/server/collaborators/revision-repair").runRevisionHintRepair();
      } finally {
        flags.forEach((name, i) => {
          if (previous[i] === undefined) delete process.env[name];
          else process.env[name] = previous[i];
        });
      }
    }
    case "registerRevisionInterest": {
      const route =
        await require("@cocalc/server/inter-bay/directory").resolveProjectBay(
          config.project,
        );
      const api =
        require("@cocalc/conat/inter-bay/collaborators").createInterBayCollaboratorsClient(
          { client: fabric, bay_id: route.bay_id },
        );
      return api.registerRevisionInterest({
        project_id: config.project,
        account_id: config.accounts[0],
        route,
      });
    }
    case "sharedProjectPage": {
      const route =
        await require("@cocalc/server/inter-bay/directory").resolveProjectBay(
          config.project,
        );
      const api =
        require("@cocalc/conat/inter-bay/collaborators").createInterBayCollaboratorsClient(
          { client: fabric, bay_id: route.bay_id },
        );
      return api.sharedProjectPage({
        project_id: config.project,
        account_ids: args.account_ids ?? [config.accounts[0]],
        home_bay_id: config.bays[1],
        route,
        generation: null,
        revision: 0,
        after_key: "",
      });
    }
    case "installScan": {
      const scan = require("@cocalc/database/postgres/collaborators/collaborators-scan");
      await scan.syncCollaborationScanSchema(pool);
      await require("@cocalc/database/postgres/collaborators/collaborators-scan-actor").syncCollaborationScanActorSchema(
        pool,
      );
      process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE = "1";
      return true;
    }
    case "scanHome": {
      const api =
        require("@cocalc/conat/inter-bay/collaborators").createInterBayCollaboratorsClient(
          { client: fabric, bay_id: args.bay_id },
        );
      return api.scanAtHome({
        ...args.request,
        route: { bay_id: args.bay_id },
      });
    }
    case "scanActorRace": {
      if (config.role !== "a") throw Error("account home fixture required");
      return await require("@cocalc/database/postgres/collaborators/collaborators-scan-actor").reserveCollaborationScanActor(
        args.request,
      );
    }
    case "scanProjectLock": {
      if (config.role !== "owner") throw Error("owner fixture required");
      if (args.release) {
        if (scanProjectLock) {
          const db = scanProjectLock;
          scanProjectLock = undefined;
          try {
            await db.query("ROLLBACK");
          } finally {
            db.release();
          }
        }
        return true;
      }
      if (scanProjectLock) throw Error("fixture lock already held");
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        await db.query(
          "SELECT project_id FROM projects WHERE project_id=$1 FOR UPDATE",
          [config.project],
        );
        scanProjectLock = db;
        return true;
      } catch (err) {
        try {
          await db.query("ROLLBACK");
        } finally {
          db.release();
        }
        throw err;
      }
    }
    case "scanRace": {
      if (config.role !== "owner") throw Error("owner fixture required");
      const scan = require("@cocalc/database/postgres/collaborators/collaborators-scan");
      const authority = { owning_bay_id: config.bays[0] };
      const operations = {
        admit: scan.admitCollaborationScan,
        start: scan.startCollaborationScan,
        claim: scan.claimCollaborationScanDispatch,
        release: scan.releaseCollaborationScanDispatch,
        retire: scan.retireExpiredQueuedCollaborationScan,
      };
      if (!operations[args.operation])
        throw Error("unknown scan fixture operation");
      return await operations[args.operation](args.request, authority);
    }
    case "demand": {
      const demand = require("@cocalc/database/postgres/collaborators/collaborators-demand");
      if (args.operation === "pruneProjectDuringRenewal") {
        const db = await pool.connect();
        try {
          await db.query("BEGIN");
          await db.query(
            `UPDATE collaboration_project_demand SET grace_until=now()+interval '1 day'
            WHERE account_id=$1 AND project_id=$2`,
            [config.accounts[0], config.project],
          );
          const deleted = await demand.pruneCollaborationProjectDemand();
          await db.query("COMMIT");
          return {
            deleted,
            afterCommit: await demand.pruneCollaborationProjectDemand(),
          };
        } catch (err) {
          await db.query("ROLLBACK");
          throw err;
        } finally {
          db.release();
        }
      }
      if (args.operation === "install") {
        await demand.syncCollaborationDemandSchema(pool);
        process.env.COCALC_PEOPLE_DEMAND_PROTOTYPE = "1";
        return null;
      }
      const account_id = config.accounts[config.role === "a" ? 0 : 1];
      switch (args.operation) {
        case "membershipFeed":
          await require("@cocalc/server/account/project-feed").applyAccountProjectFeedUpsertOnHomeBay(
            {
              type: "project.upsert",
              ts: Date.now(),
              account_id,
              project: {
                project_id: args.opts?.project_id ?? config.project,
                owning_bay_id: config.bays[0],
                title: "Membership demand fixture",
                description: "",
                host_id: null,
                users: {
                  [account_id]: { group: args.opts?.group ?? "collaborator" },
                },
                state: {},
                last_active: {},
                last_edited: null,
              },
            },
          );
          return null;
        case "maintenance":
          await require("@cocalc/server/collaborators/maintenance").runCollaboratorsMaintenance();
          await require("@cocalc/server/collaborators/maintenance").runCollaboratorsAccessMaintenance();
          return null;
        case "enableScheduler":
          process.env.COCALC_PEOPLE_EVENT_FANOUT_PROTOTYPE = "1";
          process.env.COCALC_PEOPLE_DEMAND_SCHEDULER_PROTOTYPE = "1";
          return null;
        case "claimProjection":
          return require("@cocalc/database/postgres/collaborators/collaborators-projection").claimCollaborationProjectionJobs(
            config.bays[config.role === "a" ? 1 : 2],
          );
        case "claimAccess":
          return require("@cocalc/database/postgres/collaborators/collaborators-access").claimCollaborationAccess(
            config.bays[config.role === "a" ? 1 : 2],
          );
        case "activationPass":
          return demand.runCollaborationDemandActivation(
            config.bays[config.role === "a" ? 1 : 2],
          );
        case "activate":
          return demand.activateCollaborationDemand(
            account_id,
            args.opts?.limit,
          );
        case "acquire":
          return demand.acquireCollaborationDemand({
            ...args.opts,
            account_id,
          });
        case "renew":
          return demand.renewCollaborationDemand({ ...args.opts, account_id });
        case "release":
          return demand.releaseCollaborationDemand({
            ...args.opts,
            account_id,
          });
        case "inspect":
          return demand.inspectCollaborationDemand(account_id);
        case "prune":
          return demand.pruneCollaborationDemand();
        default:
          throw Error("unknown fixture demand operation");
      }
    }
    case "tick":
      if (config.role === "host") {
        await journalService.runOnce();
        return null;
      }
      await pool.query(
        "UPDATE collaboration_access SET due_at=now(),lease_due_at=now() WHERE project_id=$1",
        [config.project],
      );
      await pool.query(
        "UPDATE collaboration_notification_cursors SET due_at=now() WHERE project_id=$1",
        [config.project],
      );
      await require("@cocalc/server/collaborators/maintenance").runCollaboratorsMaintenance();
      await require("@cocalc/server/collaborators/maintenance").runCollaboratorsAccessMaintenance();
      return null;
    case "membership":
      if (config.role === "owner")
        await pool.query(
          "UPDATE projects SET users=$2::jsonb WHERE project_id=$1",
          [config.project, JSON.stringify(users(args.group))],
        );
      else {
        hostRequire("@cocalc/lite/hub/sqlite/database").upsertRow(
          "projects",
          JSON.stringify({ project_id: config.project }),
          { project_id: config.project, users: users(args.group) },
        );
        hostRequire(
          "@cocalc/project-host/conat-auth",
        ).clearProjectHostConatAuthCaches();
      }
      return null;
    case "inspect":
      if (config.role !== "host")
        return {
          counters,
          database: (await pool.query("SELECT current_database() AS name"))
            .rows[0].name,
        };
      return {
        counters,
        droppedReplies,
        project: hostRequire("@cocalc/project-host/sqlite/projects").getProject(
          config.project,
        ),
        rows: await require("node:fs/promises").readFile(
          join(config.directory, "volume/.cocalc/collaborators.chat"),
          "utf8",
        ),
      };
    default:
      throw Error(`unknown fixture command ${name}`);
  }
}
async function shutdown() {
  if (closing) return closing;
  closing = (async () => {
    if (hostService) await hostService.close();
    if (journalService)
      await hostRequire(
        "@cocalc/project-host/collaborators",
      ).stopCollaborators();
    try {
      await require("@cocalc/sync/editor/generic/sync-doc").SyncDoc.closeAllForTests?.();
    } catch {}
    for (const resource of closeables.reverse()) await resource?.close?.();
    if (pool) await pool.end();
  })();
  return closing;
}
process.on("message", async ({ id, name, args }) => {
  try {
    const result =
      name === "shutdown" ? await shutdown() : await command(name, args);
    process.send?.({ id, result: result ?? null });
    if (name === "shutdown") process.disconnect();
  } catch (error) {
    process.send?.({ id, error: error.stack ?? String(error) });
  }
});
process.on("disconnect", () => {
  void shutdown().finally(() => process.exit(0));
});
