/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { CollaboratorsApi } from "@cocalc/conat/hub/api/collaborators";
import { normalizePrivateAlias } from "@cocalc/util/private-alias";
import {
  chatAliasTarget,
  readPersonAliases,
  writePersonAlias,
} from "./aliases";
import { stageCollaborationRelationPage } from "@cocalc/database/postgres/collaborators-relations-owner";
import {
  listCollaborationParticipants,
  listCollaborationReferences,
} from "@cocalc/database/postgres/collaborators-relations-query";
import {
  getCollaborationRoom,
  replaceCollaborationRoom,
} from "@cocalc/database/postgres/collaborators-room-replacement";
import {
  collaborationDiscoveryForHost,
  getCollaborationDiscovery,
  reportCollaborationDiscovery,
} from "@cocalc/database/postgres/collaborators-census";
import {
  discoveryCoverage,
  validateDiscoveryReport,
} from "@cocalc/util/collaboration-census";
import { createInterBayCollaboratorsClient } from "@cocalc/conat/inter-bay/collaborators";
import type {
  CollaborationRoute,
  CollaborationProjectionRequest,
  InterBayCollaboratorsApi,
  CollaborationAccessRequest,
} from "@cocalc/conat/inter-bay/collaborators";
import {
  readCollaborationProjectPage,
  overlayCollaborationProjectPage,
} from "@cocalc/database/postgres/collaborators-project-page";
import { collaborationCheckpointPage } from "@cocalc/database/postgres/collaborators-checkpoint";
import { requestCollaborationSource } from "@cocalc/database/postgres/collaborators-adoption";
import { readCollaborationAccess } from "@cocalc/database/postgres/collaborators-access";
import type { CollaborationAccessJob } from "@cocalc/database/postgres/collaborators-access";
import getPool from "@cocalc/database/pool";
import { accountProjectPins } from "@cocalc/backend/collaborators/project-pins";
import { conat } from "@cocalc/backend/conat";
import { withAccountRehomeWriteFence } from "@cocalc/database/postgres/account-rehome-fence";
import {
  checkCollaborationRevision,
  bumpCollaborationRevision,
} from "@cocalc/database/postgres/collaborators-changes";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  uuid,
  validateSnapshot,
  validateSource,
  validateTarget,
} from "@cocalc/database/postgres/collaborators-common";
import {
  collaborationRoomForHost,
  collaborationSourcePage,
  collaborationWriterState,
  ensureCollaborationRoom,
  getOwnedCollaborationResource,
  ingestCollaborationSnapshot,
  readCollaborationProjection,
  registerCollaborationSource,
  relocateCollaborationSource,
  markCollaborationRoomInitialized,
} from "@cocalc/database/postgres/collaborators-owner";
import {
  listCollaborationPeople,
  listCollaborationProjects,
  listCollaborationResources,
} from "@cocalc/database/postgres/collaborators-discovery";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import {
  resolveProjectBay,
  resolveProjectBays,
} from "@cocalc/server/inter-bay/directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import type { CollaborationNotificationJob } from "@cocalc/util/collaboration-attention";
import { readCollaborationNotificationPage } from "@cocalc/database/postgres/collaborators-notifications";
import {
  collaborationPersonalState,
  updateCollaborationPersonalState,
} from "./personal";

async function enabled() {
  if (!(await getServerSettings()).collaborators_enabled)
    throw Error("Collaborators is not enabled on this server");
}
async function accountRevision(account_id: string, since?: string) {
  const pins = await accountProjectPins(conat(), account_id).revision();
  return checkCollaborationRevision(account_id, since, pins);
}
function client(bay_id: string): InterBayCollaboratorsApi {
  return bay_id === getConfiguredBayId()
    ? collaboratorsControl
    : createInterBayCollaboratorsClient({
        client: getInterBayFabricClient(),
        bay_id,
      });
}
async function home<T>(
  account_id: string | undefined,
  invoke: (
    api: InterBayCollaboratorsApi,
    route: CollaborationRoute,
  ) => Promise<T>,
) {
  uuid(account_id, "authenticated account_id");
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  if (!home_bay_id) throw Error("collaboration account home unavailable");
  return invoke(client(home_bay_id), { bay_id: home_bay_id });
}
async function owner<T>(
  project_id: string,
  invoke: (
    api: InterBayCollaboratorsApi,
    route: CollaborationRoute,
  ) => Promise<T>,
) {
  uuid(project_id, "project_id");
  const route = await resolveProjectBay(project_id);
  if (!route) throw Error("collaboration project owner unavailable");
  return invoke(client(route.bay_id), route);
}
async function checkHome(
  account_id: string | undefined,
  route: CollaborationRoute,
) {
  await enabled();
  uuid(account_id, "authenticated account_id");
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  if (
    !home_bay_id ||
    home_bay_id !== getConfiguredBayId() ||
    route?.bay_id !== home_bay_id
  )
    throw Error("stale collaboration account-home route");
  const row = (
    await getPool().query(
      "SELECT deleted,banned FROM accounts WHERE account_id=$1",
      [account_id],
    )
  ).rows[0];
  if (!row || row.deleted || row.banned) throw Error("account unavailable");
}
async function checkOwner(project_id: string, route: CollaborationRoute) {
  uuid(project_id, "project_id");
  const actual = await resolveProjectBay(project_id);
  if (
    !actual ||
    actual.bay_id !== getConfiguredBayId() ||
    route?.bay_id !== actual.bay_id ||
    route?.epoch !== actual.epoch
  )
    throw Error("stale collaboration project-owner route");
  return { owning_bay_id: actual.bay_id };
}
let active = 0;
const hosts = new Map<string, number>();
async function writer<T>(
  opts: { project_id: string; host_id?: string; route: CollaborationRoute },
  fn: (authority: { owning_bay_id: string; host_id: string }) => Promise<T>,
) {
  uuid(opts.host_id, "authenticated host_id");
  const count = hosts.get(opts.host_id) ?? 0;
  if (active >= 8 || count >= 2)
    throw Error("collaboration ingestion busy; retry later");
  active++;
  hosts.set(opts.host_id, count + 1);
  try {
    return await fn({
      ...(await checkOwner(opts.project_id, opts.route)),
      host_id: opts.host_id,
    });
  } finally {
    active--;
    const remaining = hosts.get(opts.host_id)! - 1;
    if (remaining) hosts.set(opts.host_id, remaining);
    else hosts.delete(opts.host_id);
  }
}

/** Public hub calls already have their principal injected by auth-first handlers. */
export const collaboratorsApi: CollaboratorsApi = {
  async resolveChatAlias(opts) {
    await enabled();
    return home(opts.account_id, (api, route) =>
      api.resolveChatAlias({ ...opts, route }),
    );
  },
  async resolvePersonAlias(opts) {
    await enabled();
    return home(opts.account_id, (api, route) =>
      api.resolvePersonAlias({ ...opts, route }),
    );
  },
  async getPersonAlias(opts) {
    await enabled();
    return home(opts.account_id, (api, route) =>
      api.getPersonAlias({ ...opts, route }),
    );
  },
  async setPersonAlias(opts) {
    await enabled();
    return home(opts.account_id, (api, route) =>
      api.setPersonAlias({ ...opts, route }),
    );
  },
  async stageRelationPage(opts) {
    await enabled();
    uuid(opts.host_id, "authenticated host_id");
    return owner(opts.page.snapshot.project_id, (api, route) =>
      api.stageRelationPage({ ...opts, route }),
    );
  },
  async listParticipants(opts) {
    await enabled();
    uuid(opts.account_id, "authenticated account_id");
    validateTarget(opts);
    return owner(opts.project_id, (api, route) =>
      api.listParticipants({ ...opts, route }),
    );
  },
  async listReferences(opts) {
    await enabled();
    uuid(opts.account_id, "authenticated account_id");
    validateTarget(opts);
    return owner(opts.project_id, (api, route) =>
      api.listReferences({ ...opts, route }),
    );
  },
  async getRoom(opts) {
    await enabled();
    uuid(opts.account_id, "authenticated account_id");
    return owner(opts.project_id, (api, route) =>
      api.getRoom({ ...opts, route }),
    );
  },
  async replaceRoomForHost(opts) {
    await enabled();
    uuid(opts.host_id, "authenticated host_id");
    return owner(opts.project_id, (api, route) =>
      api.replaceRoomForHost({ ...opts, route }),
    );
  },
  async getDiscovery(opts) {
    await enabled();
    uuid(opts.account_id, "authenticated account_id");
    return owner(opts.project_id, (api, route) =>
      api.getDiscovery({ ...opts, route }),
    );
  },
  async discoveryForHost(opts) {
    await enabled();
    uuid(opts.host_id, "authenticated host_id");
    return owner(opts.project_id, (api, route) =>
      api.discoveryForHost({ ...opts, route }),
    );
  },
  async reportDiscovery(opts) {
    await enabled();
    uuid(opts.host_id, "authenticated host_id");
    if (opts.expected_run_id !== null)
      uuid(opts.expected_run_id, "expected_run_id");
    const report = validateDiscoveryReport(opts.report);
    return owner(opts.project_id, (api, route) =>
      api.reportDiscovery({
        project_id: opts.project_id,
        host_id: opts.host_id,
        expected_run_id: opts.expected_run_id,
        report,
        route,
      }),
    );
  },
  async checkpointPage(opts) {
    uuid(opts.host_id, "authenticated host_id");
    validateSource(opts);
    return owner(opts.project_id, (api, route) =>
      api.checkpointPage({ ...opts, route }),
    );
  },
  async requestSource(opts) {
    await enabled();
    uuid(opts.account_id, "authenticated account_id");
    validateSource(opts);
    return owner(opts.project_id, (api, route) =>
      api.requestSource({ ...opts, route }),
    );
  },
  async listProjectResources(opts) {
    await enabled();
    return home(opts.account_id, (api, route) =>
      api.listProjectResources({ ...opts, route }),
    );
  },
  async relocateSource(opts) {
    uuid(opts.host_id, "authenticated host_id");
    return owner(opts.project_id, (api, route) =>
      api.relocateSource({ ...opts, route }),
    );
  },
  async markRoomInitialized(opts) {
    await enabled();
    uuid(opts.host_id, "authenticated host_id");
    return owner(opts.project_id, (api, route) =>
      api.markRoomInitialized({ ...opts, route }),
    );
  },
  async check(opts) {
    await enabled();
    return home(opts.account_id, (api, route) => api.check({ ...opts, route }));
  },
  writerState,
  sourcePage,
  listPeople: async (opts) => {
    await enabled();
    return home(opts.account_id, (api, route) =>
      api.listPeople({ ...opts, route }),
    );
  },
  listProjects: async (opts) => {
    await enabled();
    return home(opts.account_id, (api, route) =>
      api.listProjects({ ...opts, route }),
    );
  },
  setProjectPinned: async (opts) => {
    await enabled();
    return home(opts.account_id, (api, route) =>
      api.setProjectPinned({ ...opts, route }),
    );
  },
  listResources: async (opts) => {
    await enabled();
    return home(opts.account_id, (api, route) =>
      api.listResources({ ...opts, route }),
    );
  },
  getResource: async (opts) => {
    await enabled();
    validateTarget(opts);
    return home(opts.account_id, (api, route) =>
      api.getResource({ ...opts, route }),
    );
  },
  setPersonalState: async (opts) => {
    await enabled();
    validateTarget(opts);
    return home(opts.account_id, (api, route) =>
      api.setPersonalState({ ...opts, route }),
    );
  },
  ensureRoom: async (opts) => {
    await enabled();
    uuid(opts.account_id, "authenticated account_id");
    return owner(opts.project_id, (api, route) =>
      api.ensureRoom({ ...opts, route }),
    );
  },
  roomForHost: async (opts) => {
    await enabled();
    uuid(opts.host_id, "authenticated host_id");
    uuid(opts.requesting_account_id, "requesting_account_id");
    return owner(opts.project_id, (api, route) =>
      api.roomForHost({ ...opts, route }),
    );
  },
  registerSource: async (opts) => {
    uuid(opts.host_id, "authenticated host_id");
    validateSource(opts);
    return owner(opts.project_id, (api, route) =>
      api.registerSource({ ...opts, route }),
    );
  },
  ingest: async (opts) => {
    uuid(opts.host_id, "authenticated host_id");
    const snapshot = validateSnapshot(opts.snapshot);
    return owner(snapshot.project_id, (api, route) =>
      api.ingest({ host_id: opts.host_id, snapshot, route }),
    );
  },
};

export async function writerState(opts: {
  project_id: string;
  chat_path: string;
  host_id?: string;
}) {
  uuid(opts.host_id, "authenticated host_id");
  validateSource(opts);
  return owner(opts.project_id, (api, route) =>
    api.writerState({ ...opts, route }),
  );
}
export async function sourcePage(opts: {
  project_id: string;
  host_id?: string;
  after?: string;
}) {
  uuid(opts.host_id, "authenticated host_id");
  return owner(opts.project_id, (api, route) =>
    api.sourcePage({ ...opts, route }),
  );
}

/** Trusted fabric only; reject stale destinations rather than forwarding loops. */
export const collaboratorsControl: InterBayCollaboratorsApi = {
  async resolveChatAlias(opts) {
    await checkHome(opts.account_id, opts.route);
    const target = await chatAliasTarget(opts.account_id!, opts.alias);
    if (!target) return null;
    // The alias is a locator only. Always reauthorize at the current owner.
    return collaboratorsControl.getResource({
      ...target,
      account_id: opts.account_id,
      route: opts.route,
    });
  },
  async resolvePersonAlias(opts) {
    await checkHome(opts.account_id, opts.route);
    const alias = normalizePrivateAlias(opts.alias);
    const aliases = await readPersonAliases(opts.account_id!);
    const person_id = Object.keys(aliases).find((id) => aliases[id] === alias);
    if (!person_id) return null;
    const page = await listCollaborationPeople({
      account_id: opts.account_id,
      person_id,
      limit: 1,
    });
    return page.items[0] ?? null;
  },
  async getPersonAlias(opts) {
    await checkHome(opts.account_id, opts.route);
    uuid(opts.person_id, "person_id");
    const page = await listCollaborationPeople({
      account_id: opts.account_id,
      person_id: opts.person_id,
      limit: 1,
    });
    if (!page.items.length) throw Error("Person is not accessible");
    return {
      alias:
        (await readPersonAliases(opts.account_id!))[
          opts.person_id.toLowerCase()
        ] ?? null,
    };
  },
  async setPersonAlias(opts) {
    await checkHome(opts.account_id, opts.route);
    return writePersonAlias(
      opts.account_id!,
      opts.person_id,
      opts.alias,
      async () => {
        await checkHome(opts.account_id, opts.route);
        const page = await listCollaborationPeople({
          account_id: opts.account_id,
          person_id: opts.person_id,
          limit: 1,
        });
        if (!page.items.length) throw Error("Person is not accessible");
      },
    );
  },
  async stageRelationPage(opts) {
    await enabled();
    return writer(
      { ...opts, project_id: opts.page.snapshot.project_id },
      (authority) => stageCollaborationRelationPage(opts.page, authority),
    );
  },
  async listParticipants(opts) {
    await enabled();
    return listCollaborationParticipants(
      opts,
      await checkOwner(opts.project_id, opts.route),
    );
  },
  async listReferences(opts) {
    await enabled();
    return listCollaborationReferences(
      opts,
      await checkOwner(opts.project_id, opts.route),
    );
  },
  async getRoom(opts) {
    await enabled();
    uuid(opts.account_id, "authenticated account_id");
    return getCollaborationRoom(
      opts.project_id,
      opts.account_id,
      await checkOwner(opts.project_id, opts.route),
    );
  },
  async replaceRoomForHost(opts) {
    await enabled();
    return writer(opts, (authority) =>
      replaceCollaborationRoom(opts, authority),
    );
  },
  async getDiscovery(opts) {
    await enabled();
    uuid(opts.account_id, "authenticated account_id");
    return getCollaborationDiscovery(
      { project_id: opts.project_id, account_id: opts.account_id! },
      await checkOwner(opts.project_id, opts.route),
    );
  },
  async discoveryForHost(opts) {
    await enabled();
    return writer(opts, (authority) =>
      collaborationDiscoveryForHost(opts.project_id, authority),
    );
  },
  async reportDiscovery(opts) {
    await enabled();
    return writer(opts, (authority) =>
      reportCollaborationDiscovery(opts, authority),
    );
  },
  checkpointPage: (opts) =>
    writer(opts, (authority) => collaborationCheckpointPage(opts, authority)),
  async requestSource(opts) {
    await enabled();
    uuid(opts.account_id, "authenticated account_id");
    return requestCollaborationSource(
      { ...opts, account_id: opts.account_id },
      await checkOwner(opts.project_id, opts.route),
    );
  },
  async listProjectResources(opts) {
    await checkHome(opts.account_id, opts.route);
    const { revision } = await accountRevision(opts.account_id!);
    const page = await owner(opts.project_id, (api, route) =>
      api.ownedProjectResources({ ...opts, route }),
    );
    return {
      ...(await overlayCollaborationProjectPage(opts.account_id!, page)),
      revision,
    };
  },
  async ownedProjectResources(opts) {
    await enabled();
    const authority = await checkOwner(opts.project_id, opts.route);
    const page = await readCollaborationProjectPage(opts, authority);
    const discovery = discoveryCoverage(
      await getCollaborationDiscovery(
        { project_id: opts.project_id, account_id: opts.account_id! },
        authority,
      ),
    );
    return {
      ...page,
      coverage: discovery.coverage,
      coverage_message:
        `${discovery.coverage_message} ${page.coverage_message ?? ""}`.trim(),
    };
  },
  async refreshAccess(opts) {
    await enabled();
    if (
      opts.route.bay_id !== getConfiguredBayId() ||
      !Array.isArray(opts.requests) ||
      opts.requests.length > 50
    )
      throw Error("invalid collaboration access route/batch");
    for (const r of opts.requests) {
      uuid(r.project_id, "project_id");
      uuid(r.account_id, "account_id");
    }
    const routes = await resolveProjectBays(
      opts.requests.map((r) => r.project_id),
    );
    for (const r of opts.requests) {
      const route = routes.get(r.project_id);
      if (
        !route ||
        route.bay_id !== opts.route.bay_id ||
        route.epoch !== r.epoch
      )
        throw Error("stale collaboration project-owner route");
    }
    return readCollaborationAccess(opts.requests, opts.route.bay_id);
  },
  relocateSource: (opts) =>
    writer(opts, (authority) => relocateCollaborationSource(opts, authority)),
  async markRoomInitialized(opts) {
    await enabled();
    return writer(opts, (authority) =>
      markCollaborationRoomInitialized(opts, authority),
    );
  },
  async check(opts) {
    await checkHome(opts.account_id, opts.route);
    return accountRevision(opts.account_id!, opts.since);
  },
  async listPeople(opts) {
    await checkHome(opts.account_id, opts.route);
    const { revision } = await accountRevision(opts.account_id!);
    return { ...(await listCollaborationPeople(opts)), revision };
  },
  async listProjects(opts) {
    await checkHome(opts.account_id, opts.route);
    const { revision } = await accountRevision(opts.account_id!);
    const pins = await accountProjectPins(conat(), opts.account_id!).read();
    return { ...(await listCollaborationProjects(opts, pins)), revision };
  },
  async setProjectPinned(opts) {
    await checkHome(opts.account_id, opts.route);
    uuid(opts.project_id, "project_id");
    if (typeof opts.pinned !== "boolean") throw Error("invalid project pin");
    return withAccountRehomeWriteFence({
      account_id: opts.account_id!,
      action: "change project favorites",
      fn: async (db) => {
        await checkHome(opts.account_id, opts.route);
        const page = await listCollaborationProjects({
          account_id: opts.account_id,
          project_id: opts.project_id,
          limit: 1,
        });
        if (!page.items.length) throw Error("project is not accessible");
        await accountProjectPins(conat(), opts.account_id!).set(
          opts.project_id,
          opts.pinned,
        );
        await bumpCollaborationRevision(db, opts.account_id!);
        return { pinned: opts.pinned };
      },
    });
  },
  async listResources(opts) {
    await checkHome(opts.account_id, opts.route);
    const { revision } = await accountRevision(opts.account_id!);
    const page = await listCollaborationResources(opts);
    if (!opts.project_id) return { ...page, revision };
    const discovery = discoveryCoverage(
      await owner(opts.project_id, (api, route) =>
        api.getDiscovery({
          account_id: opts.account_id,
          project_id: opts.project_id!,
          route,
        }),
      ),
    );
    return {
      ...page,
      revision,
      coverage: discovery.coverage,
      coverage_message:
        `${discovery.coverage_message} ${page.coverage_message ?? ""}`.trim(),
    };
  },
  async getResource(opts) {
    await checkHome(opts.account_id, opts.route);
    const current = await owner(opts.project_id, (api, route) =>
      api.ownedResource({ ...opts, route }),
    );
    if (!current) return null;
    const {
      artifact_entry_ids: _history,
      agent_resource_ids: _agents,
      agent_catalog_resource_id: _catalog,
      ...resource
    } = current;
    return {
      ...resource,
      personal: await collaborationPersonalState(opts.account_id!, current),
    };
  },
  async setPersonalState(opts) {
    await checkHome(opts.account_id, opts.route);
    const current = await owner(opts.project_id, (api, route) =>
      api.ownedResource({ ...opts, route }),
    );
    if (!current) throw Error("collaboration resource unavailable");
    const result = await updateCollaborationPersonalState(
      opts.account_id!,
      current,
      opts.patch,
    );
    // Revocation racing a home write never returns fresh resource metadata.
    await owner(opts.project_id, (api, route) =>
      api.ownedResource({ ...opts, route }),
    );
    return result;
  },
  async ensureRoom(opts) {
    await enabled();
    uuid(opts.account_id, "authenticated account_id");
    return ensureCollaborationRoom(
      opts.project_id,
      opts.account_id,
      opts.request_id,
      await checkOwner(opts.project_id, opts.route),
    );
  },
  async roomForHost(opts) {
    await enabled();
    uuid(opts.requesting_account_id, "requesting_account_id");
    return writer(opts, (authority) =>
      collaborationRoomForHost(
        opts.project_id,
        opts.requesting_account_id,
        authority,
      ),
    );
  },
  registerSource: (opts) =>
    writer(opts, async (authority) => ({
      epoch: await registerCollaborationSource(
        opts,
        authority,
        opts.expected_epoch,
        opts.registration_id,
        Boolean((await getServerSettings()).collaborators_enabled),
      ),
    })),
  ingest: (opts) =>
    writer({ ...opts, project_id: opts.snapshot.project_id }, (authority) =>
      ingestCollaborationSnapshot(opts.snapshot, authority),
    ),
  writerState: (opts) =>
    writer(opts, async (authority) =>
      collaborationWriterState(
        opts,
        authority,
        Boolean((await getServerSettings()).collaborators_enabled),
      ),
    ),
  sourcePage: (opts) =>
    writer(opts, (authority) =>
      collaborationSourcePage(opts.project_id, authority, opts.after),
    ),
  async ownedResource(opts) {
    await enabled();
    uuid(opts.account_id, "authenticated account_id");
    return getOwnedCollaborationResource(
      opts,
      opts.account_id,
      await checkOwner(opts.project_id, opts.route),
    );
  },
  async projectPage(opts) {
    await enabled();
    return readCollaborationProjection(
      opts,
      await checkOwner(opts.project_id, opts.route),
    );
  },
  async notificationPage(opts) {
    await enabled();
    return readCollaborationNotificationPage(
      opts.job,
      await checkOwner(opts.job.project_id, opts.route),
      opts.limit,
    );
  },
};

/** Resolve once per batch; each owner receives only its own bounded membership checks. */
export async function fetchCollaborationAccessBatches(
  jobs: CollaborationAccessJob[],
) {
  if (jobs.length > 50) throw Error("access batch limit exceeded");
  const routes = await resolveProjectBays(jobs.map((j) => j.project_id));
  const groups = new Map<
    string,
    { jobs: CollaborationAccessJob[]; requests: CollaborationAccessRequest[] }
  >();
  for (const job of jobs) {
    const route = routes.get(job.project_id);
    if (!route) throw Error("collaboration project owner unavailable");
    const group = groups.get(route.bay_id) ?? { jobs: [], requests: [] };
    group.jobs.push(job);
    group.requests.push({
      account_id: job.account_id,
      project_id: job.project_id,
      epoch: route.epoch,
    });
    groups.set(route.bay_id, group);
  }
  return [...groups].map(([bay_id, group]) => ({
    ...group,
    fetch: () =>
      client(bay_id).refreshAccess({
        route: { bay_id },
        requests: group.requests,
      }),
  }));
}

/** Background metadata fetch, not a browser API and never a compute startup. */
export async function fetchCollaborationProjection(
  opts: CollaborationProjectionRequest,
) {
  return owner(opts.project_id, (api, route) =>
    api.projectPage({ ...opts, route }),
  );
}

/** Trusted owner-routed background delivery; never expose through the public hub API. */
export async function fetchCollaborationNotificationPage(
  job: CollaborationNotificationJob,
  limit: number,
) {
  return owner(job.project_id, (api, route) =>
    api.notificationPage({ job, limit, route }),
  );
}
