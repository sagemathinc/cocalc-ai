/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { requireUuid } from "@cocalc/conat/agents/protocol";
import type {
  ArtifactCatalogApi,
  CatalogProjectRequest,
  CatalogSourceRequest,
} from "@cocalc/conat/hub/api/artifact-catalog";
import {
  createInterBayArtifactCatalogClient,
  type CatalogOwnerRoute,
  type InterBayArtifactCatalogApi,
} from "@cocalc/conat/inter-bay/artifact-catalog";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import {
  applyArtifactCatalogSnapshot,
  registerArtifactCatalogSource,
  getArtifactCatalogWriterState,
  artifactCatalogSourcePage,
  readProjectArtifactCatalog,
  readArtifactCatalogEntry,
} from "@cocalc/database/postgres/artifact-catalog";
import { validateArtifactCatalogSnapshot } from "@cocalc/util/artifact-catalog";
import { assertActor } from "@cocalc/server/agents/access";

function source(opts: CatalogSourceRequest) {
  requireUuid(opts.host_id, "authenticated host_id");
  const valid = validateArtifactCatalogSnapshot({
    schema_version: 1,
    project_id: opts.project_id,
    chat_path: opts.chat_path,
    epoch: "validate",
    sequence: 1,
    items: [],
  });
  return {
    host_id: opts.host_id!,
    project_id: valid.project_id,
    chat_path: valid.chat_path,
  };
}

async function route<T>(
  opts: CatalogSourceRequest,
  invoke: (
    api: InterBayArtifactCatalogApi,
    owner: CatalogOwnerRoute,
  ) => Promise<T>,
): Promise<T> {
  const request = source(opts);
  const owner = await resolveProjectBay(request.project_id);
  if (!owner) throw Error("artifact catalog project owner unavailable");
  return invoke(
    owner.bay_id === getConfiguredBayId()
      ? catalogOwnerControl
      : createInterBayArtifactCatalogClient({
          client: getInterBayFabricClient(),
          bay_id: owner.bay_id,
        }),
    { bay_id: owner.bay_id, epoch: owner.epoch },
  );
}

export const writerState: ArtifactCatalogApi["writerState"] = async (opts) => {
  const request = source(opts);
  return route(request, (api, route) => api.writerState({ ...request, route }));
};

export const sourcePage: ArtifactCatalogApi["sourcePage"] = async (opts) => {
  const request = {
    ...source({ ...opts, chat_path: "/home/user/.catalog.chat" }),
    after: opts.after,
  };
  return route(request, (api, route) => api.sourcePage({ ...request, route }));
};

async function readRoute<T>(
  opts: CatalogProjectRequest,
  invoke: (
    api: InterBayArtifactCatalogApi,
    route: CatalogOwnerRoute,
  ) => Promise<T>,
): Promise<T> {
  requireUuid(opts.account_id, "account_id");
  requireUuid(opts.project_id, "project_id");
  const owner = await resolveProjectBay(opts.project_id);
  if (!owner) throw Error("artifact catalog project owner unavailable");
  const api =
    owner.bay_id === getConfiguredBayId()
      ? catalogOwnerControl
      : createInterBayArtifactCatalogClient({
          client: getInterBayFabricClient(),
          bay_id: owner.bay_id,
        });
  return invoke(api, { bay_id: owner.bay_id, epoch: owner.epoch });
}

export const listProject: ArtifactCatalogApi["listProject"] = async (opts) =>
  readRoute(opts, (api, route) =>
    api.listProject({
      account_id: opts.account_id,
      project_id: opts.project_id,
      after: opts.after,
      route,
    }),
  );

export const getEntry: ArtifactCatalogApi["getEntry"] = async (opts) => {
  validateEntryId(opts.entry_id);
  return readRoute(opts, (api, route) =>
    api.getEntry({
      account_id: opts.account_id,
      project_id: opts.project_id,
      entry_id: opts.entry_id,
      route,
    }),
  );
};

function validateEntryId(entry_id: unknown): void {
  if (typeof entry_id !== "string" || !/^[a-f0-9]{64}$/.test(entry_id))
    throw Error("invalid catalog entry_id");
}
export const registerSource: ArtifactCatalogApi["registerSource"] = async (
  opts,
) => {
  const request = {
    ...source(opts),
    expected_epoch: opts.expected_epoch,
    registration_id: opts.registration_id,
  };
  requireUuid(request.registration_id, "registration_id");
  if (request.expected_epoch !== null)
    requireUuid(request.expected_epoch, "expected_epoch");
  return route(request, (api, route) =>
    api.registerSource({ ...request, route }),
  );
};
export const ingest: ArtifactCatalogApi["ingest"] = async (opts) => {
  const request = {
    ...source(opts),
    snapshot: validateArtifactCatalogSnapshot(opts.snapshot),
  };
  if (
    request.snapshot.project_id !== request.project_id ||
    request.snapshot.chat_path !== request.chat_path
  ) {
    throw Error("artifact catalog snapshot source mismatch");
  }
  return route(request, (api, route) => api.ingest({ ...request, route }));
};

let active = 0;
const perHost = new Map<string, number>();
async function owned<T>(
  opts: CatalogSourceRequest & { route: CatalogOwnerRoute },
  fn: (authority: { owning_bay_id: string; host_id: string }) => Promise<T>,
): Promise<T> {
  const request = source(opts);
  const count = perHost.get(request.host_id) ?? 0;
  if (active >= 8 || count >= 2)
    throw Error("artifact catalog ingestion busy; retry later");
  active++;
  perHost.set(request.host_id, count + 1);
  try {
    const owner = await resolveProjectBay(request.project_id);
    if (
      !owner ||
      owner.bay_id !== getConfiguredBayId() ||
      opts.route?.bay_id !== owner.bay_id ||
      opts.route?.epoch !== owner.epoch
    ) {
      throw Error("stale artifact catalog project routing");
    }
    return await fn({ owning_bay_id: owner.bay_id, host_id: request.host_id });
  } finally {
    active--;
    const next = perHost.get(request.host_id)! - 1;
    if (next) perHost.set(request.host_id, next);
    else perHost.delete(request.host_id);
  }
}

async function ownedRead<T>(
  opts: CatalogProjectRequest & { route: CatalogOwnerRoute },
  read: () => Promise<T>,
): Promise<T> {
  requireUuid(opts.account_id, "account_id");
  requireUuid(opts.project_id, "project_id");
  const owner = await resolveProjectBay(opts.project_id);
  if (
    !owner ||
    owner.bay_id !== getConfiguredBayId() ||
    opts.route?.bay_id !== owner.bay_id ||
    opts.route?.epoch !== owner.epoch
  )
    throw Error("stale artifact catalog project routing");
  await assertActor(opts.account_id!, opts.project_id);
  const result = await read();
  await assertActor(opts.account_id!, opts.project_id);
  return result;
}

/** Trusted fabric only. Database checks the current host assignment under lock. */
export const catalogOwnerControl: InterBayArtifactCatalogApi = {
  sourcePage: (opts) =>
    owned({ ...opts, chat_path: "/home/user/.catalog.chat" }, (authority) =>
      artifactCatalogSourcePage(opts.project_id, authority, opts.after),
    ),
  listProject: (opts) =>
    ownedRead(opts, () =>
      readProjectArtifactCatalog(opts.project_id, opts.after),
    ),
  getEntry: async (opts) => {
    validateEntryId(opts.entry_id);
    return ownedRead(opts, () =>
      readArtifactCatalogEntry(opts.project_id, opts.entry_id),
    );
  },
  writerState: (opts) =>
    owned(opts, (authority) =>
      getArtifactCatalogWriterState(source(opts), authority),
    ),
  registerSource: (opts) =>
    owned(opts, async (authority) => {
      requireUuid(opts.registration_id, "registration_id");
      if (opts.expected_epoch !== null)
        requireUuid(opts.expected_epoch, "expected_epoch");
      return {
        epoch: await registerArtifactCatalogSource(
          source(opts),
          authority,
          opts.expected_epoch,
          opts.registration_id,
        ),
      };
    }),
  ingest: (opts) =>
    owned(opts, async (authority) => {
      const snapshot = validateArtifactCatalogSnapshot(opts.snapshot);
      if (
        snapshot.project_id !== opts.project_id ||
        snapshot.chat_path !== opts.chat_path
      )
        throw Error("artifact catalog snapshot source mismatch");
      return applyArtifactCatalogSnapshot(snapshot, authority);
    }),
};
