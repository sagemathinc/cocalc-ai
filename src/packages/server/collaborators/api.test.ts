import { randomUUID } from "node:crypto";
import {
  collaboratorsApi,
  collaboratorsControl,
  fetchCollaborationAccessBatches,
} from "./api";
import {
  runCollaboratorsMaintenance,
  runCollaboratorsAccessMaintenance,
  runCollaboratorsFanoutMaintenance,
} from "./maintenance";

const owner = jest.fn();
const scanReserve = jest.fn();
const scanRead = jest.fn();
const scanAdmit = jest.fn();
const scanInspect = jest.fn();
const scanStatus = jest.fn();
const revisionInterest = jest.fn();
const sharedProjection = jest.fn();
const revisionWakeup = jest.fn();
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-revision-receiver",
  () => ({
    receiveCollaborationRevisionWakeup: (...args) => revisionWakeup(...args),
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-revision-interest",
  () => ({
    registerCollaborationRevisionInterest: (...args) =>
      revisionInterest(...args),
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-scan-actor",
  () => ({
    reserveCollaborationScanActor: (...args) => scanReserve(...args),
    reserveCollaborationScanRead: (...args) => scanRead(...args),
  }),
);
jest.mock("@cocalc/database/postgres/collaborators/collaborators-scan", () => ({
  admitCollaborationScan: (...args) => scanAdmit(...args),
  inspectCollaborationScan: (...args) => scanInspect(...args),
  readCollaborationScanStatus: (...args) => scanStatus(...args),
}));
const owners = jest.fn();
const register = jest.fn();
const access = jest.fn();
const claimAccess = jest.fn();
const overlay = jest.fn();
const checkpoint = jest.fn();
const adoption = jest.fn();
const home = jest.fn();
const dbQuery = jest.fn();
const settings = jest.fn();
const ingest = jest.fn();
const room = jest.fn();
const writerState = jest.fn();
const list = jest.fn();
const seed = jest.fn();
const ownedResource = jest.fn();
const personal = jest.fn();
const updatePersonal = jest.fn();
const projects = jest.fn();
const people = jest.fn();
const aliasTarget = jest.fn();
const readAliases = jest.fn();
const writeAlias = jest.fn();
jest.mock("./aliases", () => ({
  chatAliasTarget: (...args) => aliasTarget(...args),
  readPersonAliases: (...args) => readAliases(...args),
  writePersonAlias: (...args) => writeAlias(...args),
}));
const readPins = jest.fn();
const pinsRevision = jest.fn();
const setPin = jest.fn();
const pinFence = jest.fn();
const discovery = jest.fn();
const discoveryWriter = jest.fn();
const discoveryReport = jest.fn();
const stageRelations = jest.fn();
const participants = jest.fn();
const references = jest.fn();
const getRoom = jest.fn();
const replaceRoom = jest.fn();
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-room-replacement",
  () => ({
    getCollaborationRoom: (...args) => getRoom(...args),
    replaceCollaborationRoom: (...args) => replaceRoom(...args),
  }),
  { virtual: true },
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-relations-owner",
  () => ({
    stageCollaborationRelationPage: (...args) => stageRelations(...args),
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-relations-query",
  () => ({
    listCollaborationParticipants: (...args) => participants(...args),
    listCollaborationReferences: (...args) => references(...args),
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-census",
  () => ({
    getCollaborationDiscovery: (...args) => discovery(...args),
    collaborationDiscoveryForHost: (...args) => discoveryWriter(...args),
    reportCollaborationDiscovery: (...args) => discoveryReport(...args),
  }),
);
jest.mock("@cocalc/backend/conat", () => ({ conat: () => "local-client" }));
jest.mock("@cocalc/backend/collaborators/project-pins", () => ({
  accountProjectPins: () => ({
    read: readPins,
    set: setPin,
    revision: pinsRevision,
  }),
}));
jest.mock("@cocalc/database/postgres/account-rehome-fence", () => ({
  withAccountRehomeWriteFence: (...args) => pinFence(...args),
}));
const remote = {
  inspectDemand: jest.fn(),
  inspectProjectDemand: jest.fn(),
  scanAtOwner: jest.fn(),
  inspectScanAtOwner: jest.fn(),
  scanStatusAtOwner: jest.fn(),
  resolveChatAlias: jest.fn(),
  resolvePersonAlias: jest.fn(),
  getPersonAlias: jest.fn(),
  setPersonAlias: jest.fn(),
  getRoom: jest.fn(),
  replaceRoomForHost: jest.fn(),
  stageRelationPage: jest.fn(),
  listParticipants: jest.fn(),
  listReferences: jest.fn(),
  getDiscovery: jest.fn(),
  discoveryForHost: jest.fn(),
  reportDiscovery: jest.fn(),
  listResources: jest.fn(),
  listPeople: jest.fn(),
  listProjects: jest.fn(),
  setProjectPinned: jest.fn(),
  getResource: jest.fn(),
  ownedResource: jest.fn(),
  roomForHost: jest.fn(),
  ingest: jest.fn(),
  registerSource: jest.fn(),
  writerState: jest.fn(),
  sourcePage: jest.fn(),
  refreshAccess: jest.fn(),
  ownedProjectResources: jest.fn(),
};
let bay = "home";
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => bay,
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: (...a) => home(...a),
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (...a) => owner(...a),
  resolveProjectBays: (...a) => owners(...a),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => "trusted",
}));
jest.mock("@cocalc/conat/inter-bay/collaborators", () => ({
  createInterBayCollaboratorsClient: () => remote,
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...a) => settings(...a),
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...a) => dbQuery(...a) }),
}));
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-owner",
  () => ({
    ingestCollaborationSnapshot: (...a) => ingest(...a),
    collaborationRoomForHost: (...a) => room(...a),
    collaborationWriterState: (...a) => writerState(...a),
    getOwnedCollaborationResource: (...a) => ownedResource(...a),
    registerCollaborationSource: (...a) => register(...a),
    readCollaborationSharedProjection: (...a) => sharedProjection(...a),
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-access",
  () => ({
    readCollaborationAccess: (...a) => access(...a),
    claimCollaborationAccess: (...a) => claimAccess(...a),
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-project-page",
  () => ({
    overlayCollaborationProjectPage: (...a) => overlay(...a),
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-discovery",
  () => ({
    listCollaborationPeople: (...a) => people(...a),
    listCollaborationResources: (...a) => list(...a),
    listCollaborationProjects: (...a) => projects(...a),
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-projection",
  () => ({
    seedCollaborationProjectionJobs: (...a) => seed(...a),
  }),
);
jest.mock("./personal", () => ({
  collaborationPersonalState: (...a) => personal(...a),
  updateCollaborationPersonalState: (...a) => updatePersonal(...a),
}));
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-checkpoint",
  () => ({
    collaborationCheckpointPage: (...a) => checkpoint(...a),
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-adoption",
  () => ({
    requestCollaborationSource: (...a) => adoption(...a),
  }),
);

const account_id = randomUUID();
const project_id = randomUUID();
const host_id = randomUUID();
const route = { bay_id: "owner", epoch: 4 };
const target = {
  project_id,
  kind: "conversation" as const,
  resource_id: "thread",
};
const snapshot = {
  project_id,
  chat_path: "/home/user/work.chat",
  epoch: randomUUID(),
  sequence: 1,
  resources: [],
};
beforeEach(() => {
  jest.clearAllMocks();
  bay = "home";
  scanRead.mockResolvedValue({ allowed: true, poll_after_ms: 1000 });
  owner.mockResolvedValue(route);
  home.mockResolvedValue({ home_bay_id: "home" });
  settings.mockResolvedValue({ collaborators_enabled: true });
  discovery.mockResolvedValue({ status: "pending" });
  remote.getDiscovery.mockResolvedValue({ status: "pending" });
  dbQuery.mockResolvedValue({ rows: [{ deleted: false, banned: false }] });
  list.mockResolvedValue({ items: [], coverage: "partial" });
  readPins.mockResolvedValue([project_id]);
  pinsRevision.mockResolvedValue("0");
  projects.mockResolvedValue({ items: [{ project_id }], coverage: "partial" });
  pinFence.mockImplementation(({ fn }) => fn({ query: dbQuery }));
  room.mockResolvedValue({
    project_id,
    room_id: randomUUID(),
    chat_path: "/home/user/.cocalc/collaborators.chat",
  });
  ingest.mockResolvedValue({ revision: 1, replayed: false });
});

test("shared projection requires bounded recipients at the same demanded home", async () => {
  const flags = [
    "COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE",
    "COCALC_PEOPLE_DEMAND_PROTOTYPE",
  ];
  const prior = flags.map((name) => process.env[name]);
  flags.forEach((name) => (process.env[name] = "1"));
  bay = "owner";
  const request = {
    project_id,
    account_ids: [account_id, randomUUID()],
    home_bay_id: "home",
    route,
    generation: null,
    revision: 0,
    after_key: "",
  };
  try {
    remote.inspectProjectDemand.mockResolvedValue({ remaining_ms: 1000 });
    sharedProjection.mockResolvedValue({ catalog: null, recipients: [] });
    expect(await collaboratorsControl.sharedProjectPage(request)).toEqual({
      catalog: null,
      recipients: [],
    });
    expect(sharedProjection).toHaveBeenCalledTimes(1);
    expect(remote.inspectProjectDemand).toHaveBeenCalledTimes(2);
    await expect(
      collaboratorsControl.sharedProjectPage({
        ...request,
        home_bay_id: "wrong",
      }),
    ).rejects.toThrow("home mismatch");
    remote.inspectProjectDemand.mockResolvedValue({ remaining_ms: 0 });
    await expect(
      collaboratorsControl.sharedProjectPage(request),
    ).rejects.toThrow("no demand");
    await expect(
      collaboratorsControl.sharedProjectPage({
        ...request,
        account_ids: Array(17).fill(account_id),
      }),
    ).rejects.toThrow("recipient count");
    expect(sharedProjection).toHaveBeenCalledTimes(1);
    delete process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE;
    await expect(
      collaboratorsControl.sharedProjectPage(request),
    ).rejects.toThrow("disabled");
  } finally {
    flags.forEach((name, i) => {
      if (prior[i] === undefined) delete process.env[name];
      else process.env[name] = prior[i];
    });
  }
});
test("revision wakeups bind the receiving home and current project owner", async () => {
  const flags = [
    "COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE",
    "COCALC_PEOPLE_DEMAND_PROTOTYPE",
  ];
  const prior = flags.map((name) => process.env[name]);
  flags.forEach((name) => (process.env[name] = "1"));
  const request = {
    project_id,
    lease_id: randomUUID(),
    owner_bay_id: "owner",
    route: { bay_id: "home" },
  };
  try {
    revisionWakeup.mockResolvedValue("2");
    expect(await collaboratorsControl.receiveRevisionWakeup(request)).toEqual({
      accepted: true,
    });
    expect(revisionWakeup).toHaveBeenCalledWith({
      project_id,
      lease_id: request.lease_id,
      owner_bay_id: "owner",
      home_bay_id: "home",
    });
    revisionWakeup.mockResolvedValue(null);
    expect(await collaboratorsControl.receiveRevisionWakeup(request)).toEqual({
      accepted: false,
    });
    await expect(
      collaboratorsControl.receiveRevisionWakeup({
        ...request,
        owner_bay_id: "wrong",
      }),
    ).rejects.toThrow("stale revision sender");
    await expect(
      collaboratorsControl.receiveRevisionWakeup({
        ...request,
        route: { bay_id: "wrong" },
      }),
    ).rejects.toThrow("stale revision receiver");
    delete process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE;
    await expect(
      collaboratorsControl.receiveRevisionWakeup(request),
    ).rejects.toThrow("disabled");
  } finally {
    flags.forEach((name, i) => {
      if (prior[i] === undefined) delete process.env[name];
      else process.env[name] = prior[i];
    });
  }
});
test("revision interests derive the home and require project-scoped demand", async () => {
  const flags = [
    "COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE",
    "COCALC_PEOPLE_DEMAND_PROTOTYPE",
  ];
  const prior = flags.map((name) => process.env[name]);
  for (const name of flags) process.env[name] = "1";
  bay = "owner";
  const request = { project_id, account_id, route };
  try {
    remote.inspectProjectDemand.mockResolvedValue({ remaining_ms: 0 });
    await expect(
      collaboratorsControl.registerRevisionInterest(request),
    ).rejects.toThrow("no home demand");
    expect(revisionInterest).not.toHaveBeenCalled();
    remote.inspectProjectDemand.mockResolvedValue({ remaining_ms: NaN });
    await expect(
      collaboratorsControl.registerRevisionInterest(request),
    ).rejects.toThrow("no home demand");
    remote.inspectProjectDemand.mockResolvedValue({ remaining_ms: 5000 });
    revisionInterest.mockResolvedValue({ lease_id: "lease" });
    expect(
      await collaboratorsControl.registerRevisionInterest(request),
    ).toEqual({ lease_id: "lease" });
    expect(remote.inspectProjectDemand).toHaveBeenCalledWith({
      account_id,
      project_id,
      route: { bay_id: "home" },
    });
    expect(revisionInterest).toHaveBeenCalledWith(
      {
        project_id,
        account_id,
        home_bay_id: "home",
        ttl_ms: expect.any(Number),
      },
      expect.objectContaining({ owning_bay_id: "owner" }),
    );
    expect(revisionInterest.mock.calls[0][0].ttl_ms).toBeLessThanOrEqual(5000);
    await expect(
      collaboratorsControl.registerRevisionInterest({
        ...request,
        route: { bay_id: "wrong" },
      }),
    ).rejects.toThrow("stale");
    delete process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE;
    await expect(
      collaboratorsControl.registerRevisionInterest(request),
    ).rejects.toThrow("disabled");
  } finally {
    flags.forEach((name, i) => {
      if (prior[i] === undefined) delete process.env[name];
      else process.env[name] = prior[i];
    });
  }
});
test("public Scan uses authoritative routes, typed results and default-off admission", async () => {
  const flags = [
    "COCALC_PEOPLE_SCAN_API_PROTOTYPE",
    "COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE",
  ];
  const prior = flags.map((flag) => process.env[flag]);
  try {
    const request = {
      account_id,
      project_id,
      request_id: randomUUID(),
      mode: "check" as const,
      route: { bay_id: "forged" },
    };
    delete process.env.COCALC_PEOPLE_SCAN_API_PROTOTYPE;
    await expect(collaboratorsApi.requestScan(request)).rejects.toThrow(
      "not enabled",
    );
    expect(scanReserve).not.toHaveBeenCalled();
    flags.forEach((flag) => (process.env[flag] = "1"));
    scanReserve.mockResolvedValue({ reserved: true, expires_at: 123 });
    const receipt = {
      admission: "accepted",
      job_id: randomUUID(),
      expires_at: 123,
    };
    remote.scanAtOwner.mockResolvedValue(receipt);
    expect(await collaboratorsApi.requestScan(request)).toEqual(receipt);
    expect(remote.scanAtOwner).toHaveBeenCalledWith({ ...request, route });
    delete process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE;
    remote.inspectScanAtOwner.mockResolvedValue(receipt);
    expect(await collaboratorsApi.inspectScan(request)).toEqual({
      allowed: true,
      value: receipt,
      poll_after_ms: 1000,
    });
    expect(remote.inspectScanAtOwner).toHaveBeenCalledWith({
      account_id,
      project_id,
      request_id: request.request_id,
      route,
    });
    remote.scanStatusAtOwner.mockResolvedValue({ state: "queued" });
    expect(
      await collaboratorsApi.getScanStatus({
        account_id,
        project_id,
        job_id: receipt.job_id,
      }),
    ).toEqual({
      allowed: true,
      value: { state: "queued" },
      poll_after_ms: 1000,
    });
    await expect(collaboratorsApi.requestScan(request)).rejects.toThrow(
      "disabled",
    );
    settings.mockResolvedValue({ collaborators_enabled: false });
    await expect(collaboratorsApi.inspectScan(request)).rejects.toThrow(
      "not enabled",
    );
  } finally {
    flags.forEach((flag, i) => {
      if (prior[i] === undefined) delete process.env[flag];
      else process.env[flag] = prior[i];
    });
  }
});

test("public Scan shares bounded in-flight slots and releases them on failure", async () => {
  const prior = process.env.COCALC_PEOPLE_SCAN_API_PROTOTYPE;
  process.env.COCALC_PEOPLE_SCAN_API_PROTOTYPE = "1";
  let finish!: (value: { collaborators_enabled: boolean }) => void;
  const pending = new Promise<{ collaborators_enabled: boolean }>(
    (resolve) => (finish = resolve),
  );
  settings.mockReturnValueOnce(pending).mockReturnValueOnce(pending);
  const request = { account_id, project_id, request_id: randomUUID() };
  const first = collaboratorsApi.inspectScan(request);
  const second = collaboratorsApi.inspectScan(request);
  try {
    await expect(
      collaboratorsApi.getScanStatus({
        account_id,
        project_id,
        job_id: randomUUID(),
      }),
    ).rejects.toThrow("busy");
    finish({ collaborators_enabled: false });
    await expect(first).rejects.toThrow("not enabled");
    await expect(second).rejects.toThrow("not enabled");
    remote.inspectScanAtOwner.mockResolvedValue(null);
    expect(await collaboratorsApi.inspectScan(request)).toEqual({
      allowed: true,
      value: null,
      poll_after_ms: 1000,
    });
  } finally {
    finish({ collaborators_enabled: false });
    await Promise.allSettled([first, second]);
    if (prior === undefined)
      delete process.env.COCALC_PEOPLE_SCAN_API_PROTOTYPE;
    else process.env.COCALC_PEOPLE_SCAN_API_PROTOTYPE = prior;
  }
});

test("public Scan bounds concurrent work across distinct accounts", async () => {
  const prior = process.env.COCALC_PEOPLE_SCAN_API_PROTOTYPE;
  process.env.COCALC_PEOPLE_SCAN_API_PROTOTYPE = "1";
  let finish!: (value: { collaborators_enabled: boolean }) => void;
  const pending = new Promise<{ collaborators_enabled: boolean }>(
    (resolve) => (finish = resolve),
  );
  settings.mockReturnValue(pending);
  const requests = Array.from({ length: 32 }, () =>
    collaboratorsApi.inspectScan({
      account_id: randomUUID(),
      project_id,
      request_id: randomUUID(),
    }),
  );
  const outcomes = Promise.allSettled(requests);
  try {
    await expect(
      collaboratorsApi.inspectScan({
        account_id: randomUUID(),
        project_id,
        request_id: randomUUID(),
      }),
    ).rejects.toThrow("busy");
    expect(home).not.toHaveBeenCalled();
    finish({ collaborators_enabled: false });
    expect(
      (await outcomes).every((result) => result.status === "rejected"),
    ).toBe(true);
  } finally {
    finish({ collaborators_enabled: false });
    await outcomes;
    if (prior === undefined)
      delete process.env.COCALC_PEOPLE_SCAN_API_PROTOTYPE;
    else process.env.COCALC_PEOPLE_SCAN_API_PROTOTYPE = prior;
  }
});

test("scan inspection routes exact identities without admission or token reservation", async () => {
  const prior = process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE;
  delete process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE;
  try {
    const request = {
      project_id,
      account_id,
      request_id: randomUUID(),
      route: { bay_id: "home" },
    };
    const statusRequest = {
      project_id,
      account_id,
      job_id: randomUUID(),
      route: request.route,
    };
    const receipt = {
      admission: "accepted",
      job_id: statusRequest.job_id,
      expires_at: 123,
    };
    remote.inspectScanAtOwner.mockResolvedValue(receipt);
    remote.scanStatusAtOwner.mockResolvedValue({ state: "queued" });
    expect(await collaboratorsControl.inspectScanAtHome(request)).toEqual({
      allowed: true,
      value: receipt,
      poll_after_ms: 1000,
    });
    expect(remote.inspectScanAtOwner).toHaveBeenCalledWith({
      ...request,
      route,
    });
    expect(await collaboratorsControl.scanStatusAtHome(statusRequest)).toEqual({
      allowed: true,
      value: { state: "queued" },
      poll_after_ms: 1000,
    });
    expect(remote.scanStatusAtOwner).toHaveBeenCalledWith({
      ...statusRequest,
      route,
    });
    remote.inspectScanAtOwner.mockRejectedValueOnce(Error("transport timeout"));
    await expect(
      collaboratorsControl.inspectScanAtHome(request),
    ).rejects.toThrow("transport timeout");
    await expect(
      collaboratorsControl.scanStatusAtHome({
        ...statusRequest,
        route: { bay_id: "wrong" },
      }),
    ).rejects.toThrow("stale");
    remote.inspectScanAtOwner.mockClear();
    remote.scanStatusAtOwner.mockClear();
    scanRead.mockResolvedValue({ allowed: false, retry_after_ms: 1000 });
    expect(await collaboratorsControl.inspectScanAtHome(request)).toEqual({
      allowed: false,
      retry_after_ms: 1000,
    });
    expect(await collaboratorsControl.scanStatusAtHome(statusRequest)).toEqual({
      allowed: false,
      retry_after_ms: 1000,
    });
    expect(remote.inspectScanAtOwner).not.toHaveBeenCalled();
    expect(remote.scanStatusAtOwner).not.toHaveBeenCalled();
    expect(scanRead).toHaveBeenLastCalledWith(account_id);
    expect(scanReserve).not.toHaveBeenCalled();
    expect(scanAdmit).not.toHaveBeenCalled();
    expect(remote.scanAtOwner).not.toHaveBeenCalled();
  } finally {
    if (prior === undefined)
      delete process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE;
    else process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE = prior;
  }
});

test("owner scan inspection preserves access failures, unknown results and routing fences", async () => {
  bay = "owner";
  const request = { project_id, account_id, request_id: randomUUID(), route };
  const statusRequest = { project_id, account_id, job_id: randomUUID(), route };
  scanInspect.mockResolvedValue(null);
  scanStatus.mockResolvedValue({ state: "unknown" });
  expect(await collaboratorsControl.inspectScanAtOwner(request)).toBeNull();
  expect(await collaboratorsControl.scanStatusAtOwner(statusRequest)).toEqual({
    state: "unknown",
  });
  expect(scanInspect).toHaveBeenCalledWith(request, { owning_bay_id: "owner" });
  expect(scanStatus).toHaveBeenCalledWith(statusRequest, {
    owning_bay_id: "owner",
  });
  scanStatus.mockRejectedValueOnce(Error("access denied"));
  await expect(
    collaboratorsControl.scanStatusAtOwner(statusRequest),
  ).rejects.toThrow("access denied");
  await expect(
    collaboratorsControl.inspectScanAtOwner({
      ...request,
      route: { ...route, epoch: 3 },
    }),
  ).rejects.toThrow("stale");
  settings.mockResolvedValue({ collaborators_enabled: false });
  await expect(
    collaboratorsControl.scanStatusAtOwner(statusRequest),
  ).rejects.toThrow("not enabled");
  expect(scanReserve).not.toHaveBeenCalled();
  expect(scanAdmit).not.toHaveBeenCalled();
});

test("internal scan reserves at home before routing to the project owner", async () => {
  const previous = process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE;
  process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE = "1";
  try {
    const request = {
      project_id,
      account_id,
      request_id: randomUUID(),
      mode: "check" as const,
      route: { bay_id: "home" },
    };
    scanReserve.mockResolvedValue({ reserved: false, retry_after_ms: 500 });
    expect(await collaboratorsControl.scanAtHome(request)).toEqual({
      admission: "throttled",
      retry_after_ms: 500,
    });
    expect(remote.scanAtOwner).not.toHaveBeenCalled();
    scanReserve.mockResolvedValue({
      reserved: true,
      expires_at: Date.now() + 10000,
    });
    remote.scanAtOwner.mockResolvedValue({
      admission: "accepted",
      job_id: "job",
      expires_at: 123,
    });
    expect(await collaboratorsControl.scanAtHome(request)).toMatchObject({
      admission: "accepted",
    });
    expect(remote.scanAtOwner).toHaveBeenCalledWith({ ...request, route });
    await expect(
      collaboratorsControl.scanAtHome({
        ...request,
        route: { bay_id: "wrong" },
      }),
    ).rejects.toThrow("stale");
    settings.mockResolvedValue({ collaborators_enabled: false });
    await expect(collaboratorsControl.scanAtHome(request)).rejects.toThrow();
  } finally {
    if (previous === undefined)
      delete process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE;
    else process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE = previous;
  }
});

test("room inspection and replacement use explicit project ownership, not account-home authority", async () => {
  await collaboratorsApi.getRoom({ project_id, account_id });
  expect(remote.getRoom).toHaveBeenCalledWith({
    project_id,
    account_id,
    route,
  });
  const write = {
    project_id,
    host_id,
    requesting_account_id: account_id,
    request: {
      version: 1 as const,
      project_id,
      request_id: randomUUID(),
      expected_room_id: randomUUID(),
      expected_chat_path: snapshot.chat_path,
    },
  };
  await collaboratorsApi.replaceRoomForHost(write);
  expect(remote.replaceRoomForHost).toHaveBeenCalledWith({ ...write, route });
  expect(getRoom).not.toHaveBeenCalled();
  expect(replaceRoom).not.toHaveBeenCalled();
  expect(home).not.toHaveBeenCalled();
  await expect(
    collaboratorsApi.replaceRoomForHost({ ...write, host_id: undefined }),
  ).rejects.toThrow("host_id");
  settings.mockResolvedValue({ collaborators_enabled: false });
  await expect(
    collaboratorsControl.notificationObligation({
      project_id,
      account_id,
      id: randomUUID(),
      membership_epoch: randomUUID(),
      route: { bay_id: "owner" },
    }),
  ).rejects.toThrow("not enabled");
  await expect(
    collaboratorsApi.getRoom({ project_id, account_id }),
  ).rejects.toThrow("not enabled");
  await expect(collaboratorsApi.replaceRoomForHost(write)).rejects.toThrow(
    "not enabled",
  );
});

test("census status and host reports route to explicit owner without initiating source work", async () => {
  await collaboratorsApi.getDiscovery({ project_id, account_id });
  expect(remote.getDiscovery).toHaveBeenCalledWith({
    project_id,
    account_id,
    route,
  });
  await collaboratorsApi.discoveryForHost({ project_id, host_id });
  expect(remote.discoveryForHost).toHaveBeenCalledWith({
    project_id,
    host_id,
    route,
  });
  const write = {
    project_id,
    host_id,
    expected_run_id: null,
    report: {
      run_id: randomUUID(),
      sequence: 1,
      coverage: "indexing" as const,
      traversal_complete: false,
      directories: 1,
      completed_directories: 0,
      entries: 0,
      candidates: 0,
      pending_candidates: 0,
      excluded_entries: 0,
      skipped_symlinks: 0,
      blocked_directories: 0,
      errors: 0,
      source_pending: 0,
      source_errors: 0,
    },
  };
  await collaboratorsApi.reportDiscovery(write);
  expect(remote.reportDiscovery).toHaveBeenCalledWith({ ...write, route });
  expect(register).not.toHaveBeenCalled();
  expect(ingest).not.toHaveBeenCalled();
  expect(room).not.toHaveBeenCalled();
  settings.mockResolvedValue({ collaborators_enabled: false });
  await expect(
    collaboratorsApi.getDiscovery({ project_id, account_id }),
  ).rejects.toThrow("not enabled");
});
test("selected project coverage reads one owner status and retains existing limitations", async () => {
  list.mockResolvedValue({
    items: [],
    coverage: "partial",
    coverage_message: "Quota fallback remains available.",
  });
  remote.getDiscovery.mockResolvedValue({ status: "unavailable" });
  const page = await collaboratorsControl.listResources({
    account_id,
    project_id,
    route: { bay_id: "home" },
  });
  expect(page.coverage).toBe("partial");
  expect(page.coverage_message).toContain("unavailable");
  expect(page.coverage_message).toContain("Quota fallback");
  expect(remote.getDiscovery).toHaveBeenCalledTimes(1);
  remote.getDiscovery.mockClear();
  await collaboratorsControl.listResources({
    account_id,
    route: { bay_id: "home" },
  });
  expect(remote.getDiscovery).not.toHaveBeenCalled();
});

test("project pin API routes only to the account home and forwards bounded filters", async () => {
  home.mockResolvedValue({ home_bay_id: "elsewhere" });
  await collaboratorsApi.listProjects({
    account_id,
    view: "pinned",
    person_id: account_id,
    search: "Geometry",
    limit: 5,
  });
  expect(remote.listProjects).toHaveBeenCalledWith({
    account_id,
    view: "pinned",
    person_id: account_id,
    search: "Geometry",
    limit: 5,
    route: { bay_id: "elsewhere" },
  });
  await collaboratorsApi.setProjectPinned({
    account_id,
    project_id,
    pinned: true,
  });
  expect(remote.setProjectPinned).toHaveBeenCalledWith({
    account_id,
    project_id,
    pinned: true,
    route: { bay_id: "elsewhere" },
  });
  expect(readPins).not.toHaveBeenCalled();
  expect(setPin).not.toHaveBeenCalled();
  expect(owner).not.toHaveBeenCalled();
});

test("local project list captures revision before favorites/page reads and supplies server-side pins", async () => {
  await collaboratorsControl.listProjects({
    account_id,
    view: "pinned",
    route: { bay_id: "home" },
  });
  const revisionCall = dbQuery.mock.calls.findIndex(([sql]) =>
    sql.includes("AS revision"),
  );
  expect(revisionCall).toBeGreaterThanOrEqual(0);
  expect(dbQuery.mock.invocationCallOrder[revisionCall]).toBeLessThan(
    readPins.mock.invocationCallOrder[0],
  );
  expect(projects).toHaveBeenCalledWith(
    expect.objectContaining({ account_id, view: "pinned" }),
    [project_id],
  );
});

test("project pin mutation is rehome-fenced, visibility-checked, and bumps account revision", async () => {
  const opts = {
    account_id,
    project_id,
    pinned: true,
    route: { bay_id: "home" },
  };
  await expect(collaboratorsControl.setProjectPinned(opts)).resolves.toEqual({
    pinned: true,
  });
  expect(pinFence).toHaveBeenCalledWith(
    expect.objectContaining({ account_id }),
  );
  expect(projects).toHaveBeenCalledWith({ account_id, project_id, limit: 1 });
  expect(setPin).toHaveBeenCalledWith(project_id, true);
  expect(
    dbQuery.mock.calls.some(([sql]) =>
      sql.includes("INSERT INTO collaboration_account_state"),
    ),
  ).toBe(true);
  setPin.mockClear();
  projects.mockResolvedValue({ items: [] });
  await expect(collaboratorsControl.setProjectPinned(opts)).rejects.toThrow(
    "not accessible",
  );
  expect(setPin).not.toHaveBeenCalled();
  pinFence.mockRejectedValueOnce(Error("rehome frozen"));
  await expect(collaboratorsControl.setProjectPinned(opts)).rejects.toThrow(
    "rehome frozen",
  );
  expect(setPin).not.toHaveBeenCalled();
});

test("project pins fail closed for disabled, stale-home and malformed requests", async () => {
  const opts = {
    account_id,
    project_id,
    pinned: true,
    route: { bay_id: "home" },
  };
  settings.mockResolvedValueOnce({ collaborators_enabled: false });
  await expect(collaboratorsApi.setProjectPinned(opts)).rejects.toThrow(
    "not enabled",
  );
  await expect(
    collaboratorsControl.setProjectPinned({
      ...opts,
      route: { bay_id: "old-home" },
    }),
  ).rejects.toThrow("stale");
  await expect(
    collaboratorsControl.setProjectPinned({ ...opts, pinned: 1 as any }),
  ).rejects.toThrow("invalid");
  expect(setPin).not.toHaveBeenCalled();
  expect(pinFence).not.toHaveBeenCalled();
});
test("feature flag fails closed for human methods and host room use, but host journals may ingest", async () => {
  settings.mockResolvedValue({ collaborators_enabled: false });
  await expect(collaboratorsApi.listResources({ account_id })).rejects.toThrow(
    "not enabled",
  );
  await expect(
    collaboratorsApi.getResource({ account_id, ...target }),
  ).rejects.toThrow("not enabled");
  await expect(
    collaboratorsApi.ensureRoom({
      account_id,
      project_id,
      request_id: randomUUID(),
    }),
  ).rejects.toThrow("not enabled");
  await expect(
    collaboratorsApi.roomForHost({
      host_id,
      project_id,
      requesting_account_id: account_id,
    }),
  ).rejects.toThrow("not enabled");
  expect(owner).not.toHaveBeenCalled();
  expect(home).not.toHaveBeenCalled();
  bay = "owner";
  await expect(collaboratorsApi.ingest({ host_id, snapshot })).resolves.toEqual(
    { revision: 1, replayed: false },
  );
  expect(ingest).toHaveBeenCalledWith(snapshot, {
    owning_bay_id: "owner",
    host_id,
  });
});
test("disabled rollout does not enumerate or backfill account projections", async () => {
  settings.mockResolvedValue({ collaborators_enabled: false });
  await runCollaboratorsMaintenance();
  await runCollaboratorsAccessMaintenance();
  const previous = process.env.COCALC_PEOPLE_EVENT_FANOUT_PROTOTYPE;
  process.env.COCALC_PEOPLE_EVENT_FANOUT_PROTOTYPE = "1";
  try {
    expect(await runCollaboratorsFanoutMaintenance()).toBe(0);
  } finally {
    if (previous === undefined)
      delete process.env.COCALC_PEOPLE_EVENT_FANOUT_PROTOTYPE;
    else process.env.COCALC_PEOPLE_EVENT_FANOUT_PROTOTYPE = previous;
  }
  expect(seed).not.toHaveBeenCalled();
  expect(claimAccess).not.toHaveBeenCalled();
});

test("demand admission remains disabled until explicit prototype opt-in", async () => {
  const previous = process.env.COCALC_PEOPLE_DEMAND_PROTOTYPE;
  delete process.env.COCALC_PEOPLE_DEMAND_PROTOTYPE;
  try {
    await expect(
      collaboratorsApi.acquireDemand({
        account_id,
        consumer_id: randomUUID(),
        scope: { kind: "all" },
      }),
    ).rejects.toThrow("prototype is not enabled");
    await expect(
      collaboratorsControl.inspectDemand({
        account_id,
        route: { bay_id: "home" },
      }),
    ).rejects.toThrow("prototype is not enabled");
    expect(home).not.toHaveBeenCalled();
  } finally {
    if (previous !== undefined)
      process.env.COCALC_PEOPLE_DEMAND_PROTOTYPE = previous;
  }
});
test("disabled source registration supplies the atomic no-new-sources fence", async () => {
  settings.mockResolvedValue({ collaborators_enabled: false });
  bay = "owner";
  register.mockRejectedValue(Error("not enabled"));
  const registration_id = randomUUID();
  await expect(
    collaboratorsApi.registerSource({
      ...snapshot,
      host_id,
      expected_epoch: null,
      registration_id,
    }),
  ).rejects.toThrow("not enabled");
  expect(register).toHaveBeenCalledWith(
    expect.objectContaining({ project_id }),
    { owning_bay_id: "owner", host_id },
    null,
    registration_id,
    false,
  );
});
test("lease refresh coalesces 50 projects to one owner RPC and validates route epochs in bulk", async () => {
  const jobs = Array.from({ length: 50 }, () => ({
    account_id,
    project_id: randomUUID(),
    grant_request_id: randomUUID(),
  }));
  owners.mockResolvedValue(new Map(jobs.map((j) => [j.project_id, route])));
  const batches = await fetchCollaborationAccessBatches(jobs);
  expect(owners).toHaveBeenCalledTimes(1);
  expect(owner).not.toHaveBeenCalled();
  expect(batches).toHaveLength(1);
  await batches[0].fetch();
  expect(remote.refreshAccess).toHaveBeenCalledWith({
    route: { bay_id: "owner" },
    requests: jobs.map((j) => ({
      account_id,
      project_id: j.project_id,
      epoch: 4,
    })),
  });
  bay = "owner";
  const opts = remote.refreshAccess.mock.calls[0][0];
  await collaboratorsControl.refreshAccess(opts);
  expect(access).toHaveBeenCalledWith(opts.requests, "owner");
  await expect(
    collaboratorsControl.refreshAccess({
      ...opts,
      requests: [{ ...opts.requests[0], epoch: 3 }],
    }),
  ).rejects.toThrow("stale");
  expect(access).toHaveBeenCalledTimes(1);
});
test("account discovery routes to home and never scans project owners", async () => {
  await collaboratorsApi.listResources({ account_id, search: "title" });
  expect(list).toHaveBeenCalledTimes(1);
  expect(owner).not.toHaveBeenCalled();
  bay = "entry";
  await collaboratorsApi.listResources({ account_id });
  expect(remote.listResources).toHaveBeenCalledWith({
    account_id,
    route: { bay_id: "home" },
  });
  await expect(
    collaboratorsControl.listResources({
      account_id,
      route: { bay_id: "home" },
    }),
  ).rejects.toThrow("stale");
});
test("selected-project fallback calls exactly one owner and overlays at account home", async () => {
  const page = { items: [], coverage: "partial" };
  remote.ownedProjectResources.mockResolvedValue(page);
  overlay.mockResolvedValue(page);
  await collaboratorsApi.listProjectResources({
    account_id,
    project_id,
    limit: 20,
  });
  expect(remote.ownedProjectResources).toHaveBeenCalledTimes(1);
  expect(remote.ownedProjectResources).toHaveBeenCalledWith({
    account_id,
    project_id,
    limit: 20,
    route,
  });
  expect(overlay).toHaveBeenCalledWith(account_id, page);
  expect(list).not.toHaveBeenCalled();
});
test("adoption is feature-gated account authority while checkpoint recovery is host-only", async () => {
  bay = "owner";
  await collaboratorsApi.requestSource({
    account_id,
    project_id,
    chat_path: snapshot.chat_path,
  });
  expect(adoption).toHaveBeenCalledWith(
    expect.objectContaining({ account_id, project_id }),
    { owning_bay_id: "owner" },
  );
  await collaboratorsApi.checkpointPage({
    host_id,
    project_id,
    chat_path: snapshot.chat_path,
  });
  expect(checkpoint).toHaveBeenCalledWith(
    expect.objectContaining({ host_id, project_id }),
    { owning_bay_id: "owner", host_id },
  );
  await expect(
    collaboratorsApi.checkpointPage({
      project_id,
      chat_path: snapshot.chat_path,
    }),
  ).rejects.toThrow("host_id");
  settings.mockResolvedValue({ collaborators_enabled: false });
  await expect(
    collaboratorsApi.requestSource({
      account_id,
      project_id,
      chat_path: snapshot.chat_path,
    }),
  ).rejects.toThrow("not enabled");
});
test("owner routing checks epoch and hosting principal before canonical host lookup", async () => {
  await collaboratorsApi.roomForHost({
    host_id,
    project_id,
    requesting_account_id: account_id,
  });
  expect(remote.roomForHost).toHaveBeenCalledWith({
    host_id,
    project_id,
    requesting_account_id: account_id,
    route,
  });
  bay = "owner";
  await collaboratorsControl.roomForHost({
    host_id,
    project_id,
    requesting_account_id: account_id,
    route,
  });
  expect(room).toHaveBeenCalledWith(project_id, account_id, {
    owning_bay_id: "owner",
    host_id,
  });
  await expect(
    collaboratorsControl.roomForHost({
      host_id,
      project_id,
      requesting_account_id: account_id,
      route: { ...route, epoch: 3 },
    }),
  ).rejects.toThrow("stale");
  await expect(
    collaboratorsApi.roomForHost({
      project_id,
      requesting_account_id: account_id,
    }),
  ).rejects.toThrow("host_id");
});
test("background writer metadata stays owner-routed and canonical flush authority fails closed with the flag", async () => {
  const request = { project_id, chat_path: snapshot.chat_path, host_id };
  await collaboratorsApi.writerState(request);
  expect(remote.writerState).toHaveBeenCalledWith({ ...request, route });
  bay = "owner";
  await collaboratorsControl.writerState({ ...request, route });
  expect(writerState).toHaveBeenLastCalledWith(
    expect.objectContaining(request),
    { owning_bay_id: "owner", host_id },
    true,
  );
  settings.mockResolvedValue({ collaborators_enabled: false });
  await collaboratorsControl.writerState({ ...request, route });
  expect(writerState).toHaveBeenLastCalledWith(
    expect.objectContaining(request),
    { owning_bay_id: "owner", host_id },
    false,
  );
  await expect(
    collaboratorsApi.writerState({ ...request, host_id: undefined }),
  ).rejects.toThrow(/host_id/);
});
test("point lookup goes from account home to resource owner, not the alias owner", async () => {
  remote.ownedResource.mockResolvedValue({ ...target, title: "shared" });
  personal.mockResolvedValue({ alias: "personal" });
  expect(await collaboratorsApi.getResource({ account_id, ...target })).toEqual(
    { ...target, title: "shared", personal: { alias: "personal" } },
  );
  expect(remote.ownedResource).toHaveBeenCalledWith({
    account_id,
    ...target,
    route,
  });
});

test("chat aliases resolve privately at home then reauthorize with the project owner", async () => {
  aliasTarget.mockResolvedValue(target);
  remote.ownedResource.mockResolvedValue({ ...target, title: "chat" });
  personal.mockResolvedValue({ alias: "weekly" });
  expect(
    await collaboratorsApi.resolveChatAlias({ account_id, alias: "weekly" }),
  ).toMatchObject(target);
  expect(aliasTarget).toHaveBeenCalledWith(account_id, "weekly");
  expect(remote.ownedResource).toHaveBeenCalledWith({
    account_id,
    ...target,
    route,
  });
  remote.ownedResource.mockRejectedValueOnce(Error("access denied"));
  await expect(
    collaboratorsApi.resolveChatAlias({ account_id, alias: "weekly" }),
  ).rejects.toThrow("access denied");
  aliasTarget.mockResolvedValue(null);
  await expect(
    collaboratorsApi.resolveChatAlias({ account_id, alias: "missing" }),
  ).resolves.toBeNull();
});

test.each([
  "resolveChatAlias",
  "resolvePersonAlias",
  "getPersonAlias",
  "setPersonAlias",
] as const)(
  "%s routes to the account home rather than the entry bay",
  async (method) => {
    bay = "entry";
    const opts = { account_id, person_id: randomUUID(), alias: "alice" };
    await collaboratorsApi[method](opts);
    expect(remote[method]).toHaveBeenCalledWith({
      ...opts,
      route: { bay_id: "home" },
    });
    expect(dbQuery).not.toHaveBeenCalled();
  },
);
test("person aliases retain People visibility checks and stale home routes fail closed", async () => {
  const person_id = randomUUID();
  readAliases.mockResolvedValue({ [person_id]: "alice" });
  people.mockResolvedValue({ items: [{ account_id: person_id }] });
  await expect(
    collaboratorsApi.resolvePersonAlias({ account_id, alias: "Alice" }),
  ).resolves.toEqual({ account_id: person_id });
  expect(people).toHaveBeenCalledWith({ account_id, person_id, limit: 1 });
  people.mockResolvedValue({ items: [] });
  await expect(
    collaboratorsApi.resolvePersonAlias({ account_id, alias: "alice" }),
  ).resolves.toBeNull();
  await expect(
    collaboratorsApi.getPersonAlias({ account_id, person_id }),
  ).rejects.toThrow("not accessible");
  await expect(
    collaboratorsControl.resolvePersonAlias({
      account_id,
      alias: "alice",
      route: { bay_id: "stale" },
    }),
  ).rejects.toThrow("stale");
  settings.mockResolvedValue({ collaborators_enabled: false });
  await expect(
    collaboratorsApi.setPersonAlias({ account_id, person_id, alias: "alice" }),
  ).rejects.toThrow("not enabled");
});
test("point lookup keeps identity migration metadata private to the account-home adapter", async () => {
  const requested = { ...target, kind: "agent" as const };
  const current = {
    ...requested,
    title: "shared agent",
    agent_id: randomUUID(),
    artifact_entry_ids: ["old-artifact-locator"],
    agent_resource_ids: ["agent-thread:old"],
    agent_catalog_resource_id: "agent-thread:old",
  };
  remote.ownedResource.mockResolvedValue(current);
  personal.mockResolvedValue({ collected: true });
  expect(
    await collaboratorsApi.getResource({ account_id, ...requested }),
  ).toEqual({
    ...requested,
    title: current.title,
    agent_id: current.agent_id,
    personal: { collected: true },
  });
  expect(personal).toHaveBeenCalledWith(account_id, current);
});
test("personal writes recheck owner authorization after mutation and never let aliases authorize", async () => {
  const current = { ...target, title: "shared" };
  remote.ownedResource
    .mockReset()
    .mockResolvedValueOnce(current)
    .mockRejectedValueOnce(Error("access denied"));
  updatePersonal.mockResolvedValue({ following: true });
  await expect(
    collaboratorsApi.setPersonalState({
      account_id,
      ...target,
      patch: { following: true },
    }),
  ).rejects.toThrow("access denied");
  expect(updatePersonal).toHaveBeenCalledWith(account_id, current, {
    following: true,
  });
  remote.ownedResource.mockReset().mockResolvedValue(null);
  updatePersonal.mockClear();
  await expect(
    collaboratorsApi.setPersonalState({
      account_id,
      ...target,
      patch: { following: true },
    }),
  ).rejects.toThrow("unavailable");
  expect(updatePersonal).not.toHaveBeenCalled();
});
test("unknown owners, stale homes and disabled accounts never fall back to local reads", async () => {
  dbQuery.mockResolvedValue({ rows: [{ banned: true }] });
  await expect(collaboratorsApi.listResources({ account_id })).rejects.toThrow(
    "unavailable",
  );
  expect(list).not.toHaveBeenCalled();
  owner.mockResolvedValue(null);
  await expect(collaboratorsApi.ingest({ host_id, snapshot })).rejects.toThrow(
    "owner unavailable",
  );
  expect(ingest).not.toHaveBeenCalled();
});

describe("complete source relations routing", () => {
  const page = {
    version: 1 as const,
    snapshot,
    page: 0,
    rows: [],
    digest: "a".repeat(64),
  };
  test("uploads and read pages route to the explicit project owner, never account-home metadata", async () => {
    remote.stageRelationPage.mockResolvedValue({ replayed: false });
    remote.listParticipants.mockResolvedValue({
      items: [{ account_id }],
      coverage: "complete",
    });
    remote.listReferences.mockResolvedValue({
      items: [],
      coverage: "indexing",
    });
    await collaboratorsApi.stageRelationPage({ host_id, page });
    expect(remote.stageRelationPage).toHaveBeenCalledWith({
      host_id,
      page,
      route,
    });
    await collaboratorsApi.listParticipants({
      ...target,
      account_id,
      limit: 3,
    });
    expect(remote.listParticipants).toHaveBeenCalledWith({
      ...target,
      account_id,
      limit: 3,
      route,
    });
    await collaboratorsApi.listReferences({
      ...target,
      account_id,
      message_id: "native-message",
    });
    expect(remote.listReferences).toHaveBeenCalledWith({
      ...target,
      account_id,
      message_id: "native-message",
      route,
    });
    expect(home).not.toHaveBeenCalled();
    expect(stageRelations).not.toHaveBeenCalled();
  });
  test("owner control preserves writer/account fences and rejects stale destinations", async () => {
    bay = "owner";
    await collaboratorsControl.stageRelationPage({ host_id, page, route });
    expect(stageRelations).toHaveBeenCalledWith(page, {
      owning_bay_id: "owner",
      host_id,
    });
    await collaboratorsControl.listParticipants({
      ...target,
      account_id,
      route,
    });
    expect(participants).toHaveBeenCalledWith(
      { ...target, account_id, route },
      { owning_bay_id: "owner" },
    );
    await collaboratorsControl.listReferences({ ...target, account_id, route });
    expect(references).toHaveBeenCalledWith(
      { ...target, account_id, route },
      { owning_bay_id: "owner" },
    );
    participants.mockClear();
    await expect(
      collaboratorsControl.listParticipants({
        ...target,
        account_id,
        route: { ...route, epoch: 3 },
      }),
    ).rejects.toThrow("stale");
    expect(participants).not.toHaveBeenCalled();
    await expect(
      collaboratorsControl.stageRelationPage({ page, route }),
    ).rejects.toThrow("host_id");
  });
  test("feature-disabled and missing-principal calls do not discover owners or stage metadata", async () => {
    settings.mockResolvedValue({ collaborators_enabled: false });
    await expect(
      collaboratorsApi.stageRelationPage({ host_id, page }),
    ).rejects.toThrow("not enabled");
    await expect(
      collaboratorsApi.listParticipants({ ...target, account_id }),
    ).rejects.toThrow("not enabled");
    await expect(
      collaboratorsApi.listReferences({ ...target, account_id }),
    ).rejects.toThrow("not enabled");
    expect(owner).not.toHaveBeenCalled();
    settings.mockResolvedValue({ collaborators_enabled: true });
    await expect(collaboratorsApi.listParticipants(target)).rejects.toThrow(
      "account_id",
    );
    await expect(collaboratorsApi.stageRelationPage({ page })).rejects.toThrow(
      "host_id",
    );
  });
});
