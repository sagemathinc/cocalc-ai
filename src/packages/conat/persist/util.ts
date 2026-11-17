/*

Maybe storage available as a service.

This code is similar to the changefeed server, because
it provides a changefeed on a given persist storage,
and a way to see values.

DEVELOPMENT:

Change to the packages/backend directory and run node.

TERMINAL 1: This sets up the environment and starts the server running:

   require('@cocalc/backend/conat/persist').initServer()


TERMINAL 2: In another node session, create a client:

    user = {account_id:'00000000-0000-4000-8000-000000000000'}; storage = {path:'a.db'}; const {id, stream} = await require('@cocalc/backend/conat/persist').getAll({user, storage}); console.log({id}); for await(const x of stream) { console.log(x.data) }; console.log("DONE")

// client also does this periodically to keep subscription alive:

    await renew({user, id })

TERMINAL 3:

user = {account_id:'00000000-0000-4000-8000-000000000000'}; storage = {path:'a.db'}; const {set,get} = require('@cocalc/backend/conat/persist');  const { messageData } =require("@cocalc/conat/core/client"); 0;

   await set({user, storage, messageData:messageData('hi')})

   await get({user, storage,  seq:1})

   await set({user, storage, key:'bella', messageData:messageData('hi', {headers:{x:10}})})

   await get({user, storage,  key:'bella'})

Also getAll using start_seq:

   cf = const {id,  stream} = await require('@cocalc/backend/conat/persist').getAll({user, storage, start_seq:10}); for await(const x of stream) { console.log(x) };
*/

import { assertHasWritePermission } from "./auth";
import {
  pstream,
  PersistentStream,
  type StorageOptions,
  prepareDurableOpen,
  clearOpenBarrierPass,
} from "./storage";
import { join, posix } from "path";
import {
  syncFiles,
  ensureContainingDirectoryExists,
  prepareProjectStore,
  statSync,
} from "./context";
import type {
  PersistMaintenanceHooks,
  PersistMaintenancePath,
  PersistMaintenanceScopeType,
} from "./maintenance/types";
import {
  enterProjectOpen,
  projectOfStoragePath,
  projectReplacedInstance,
} from "./project-fence";

// this is per-server -- and "user" means where the resource is, usually
// a given project.  E.g., 500 streams in a project, across many users.
export const MAX_PER_USER = 500;
export const MAX_GLOBAL = 10000;
export const RESOURCE = "persistent storage";

// (in subject.ts, which the browser can bundle without storage)
import { SERVICE, persistSubject, type User } from "./subject";
export { SERVICE, persistSubject, type User };

function resolveTemplateBase(base: string, token: string, id: string): string {
  const placeholder = `[${token}]`;
  if (base.includes(placeholder)) {
    return base.split(placeholder).join(id);
  }
  return join(base, id);
}

// The directory that holds all of a project's databases, if projects have
// their own (e.g., /mnt/cocalc/project-[project_id]-persist).
export function projectStoreRoot(
  storagePath: string,
): { project_id: string; root: string } | undefined {
  const projectMatch = storagePath.match(/^projects\/([^/]+)(?:\/(.*))?$/);
  if (projectMatch == null || !syncFiles.localProjects) return;
  const template = syncFiles.localProjects;
  const project_id = projectMatch[1];
  if (!template.includes("[project_id]")) {
    return {
      project_id,
      root: resolveTemplateBase(template, "project_id", project_id),
    };
  }
  const [prefix, suffix] = template.split("[project_id]");
  const suffixRoot = suffix.split("/")[0] ?? "";
  return { project_id, root: `${prefix}${project_id}${suffixRoot}` };
}

export function resolveLocalPath(
  storagePath: string,
  { ephemeral }: { ephemeral?: boolean },
): string {
  const projectMatch = storagePath.match(/^projects\/([^/]+)(?:\/(.*))?$/);
  if (projectMatch) {
    const [, projectId, rest = ""] = projectMatch;
    if (syncFiles.localProjects) {
      const template = syncFiles.localProjects;
      const base = resolveTemplateBase(template, "project_id", projectId);
      const projectRoot = projectStoreRoot(storagePath)!.root;
      if (!ephemeral) {
        try {
          statSync(projectRoot);
        } catch {
          throw new Error(`project root does not exist: ${projectRoot}`);
        }
      }
      return rest ? join(base, rest) : base;
    }
  }

  const accountMatch = storagePath.match(/^accounts\/([^/]+)(?:\/(.*))?$/);
  if (accountMatch) {
    const [, accountId, rest = ""] = accountMatch;
    if (syncFiles.localAccounts) {
      const base = resolveTemplateBase(
        syncFiles.localAccounts,
        "account_id",
        accountId,
      );
      return rest ? join(base, rest) : base;
    }
  }

  const hostMatch = storagePath.match(/^hosts\/([^/]+)(?:\/(.*))?$/);
  if (hostMatch) {
    const [, hostId, rest = ""] = hostMatch;
    if (syncFiles.localHosts) {
      const base = resolveTemplateBase(syncFiles.localHosts, "host_id", hostId);
      return rest ? join(base, rest) : base;
    }
  }

  if (storagePath.startsWith("hub/") && syncFiles.localHub) {
    const rest = storagePath.slice("hub/".length);
    return rest ? join(syncFiles.localHub, rest) : syncFiles.localHub;
  }

  return join(syncFiles.local, storagePath);
}

// The durability records' OWNER of a physical stream path (028 B-2, B2-M1):
// the inverse of resolveLocalPath for the owner, i.e. what storeOwner gives
// for the logical path.  A project's stream (under the project template's
// root, or <local>/projects/<project_id>/) -> its project_id; any other
// stream under a persist root (local, hub, hosts, accounts) -> "host";
// anything else -> undefined (the caller refuses).
export function ownerOfLocalPath(
  localPath: string,
  files: {
    local: string;
    localProjects?: string;
    localAccounts?: string;
    localHosts?: string;
    localHub?: string;
  } = syncFiles,
): string | undefined {
  const syncFiles = files;
  const p = posix.normalize(localPath);
  const under = (root: string) => {
    const r = posix.normalize(root).replace(/\/+$/, "");
    return r !== "" && r !== "." && (p === r || p.startsWith(`${r}/`));
  };
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const validId = (id: string | undefined) =>
    id != null && id !== "" && id !== "." && id !== ".." ? id : undefined;
  // the subject id of p under a template root (as resolveTemplateBase builds
  // it: the token replaced, or <base>/<id> without a token)
  const idUnder = (template: string, token: string): string | undefined => {
    const t = posix.normalize(template).replace(/\/+$/, "");
    let m: RegExpMatchArray | null;
    if (t.includes(token)) {
      const [prefix, suffix] = t.split(token);
      const suffixRoot = suffix.split("/")[0] ?? "";
      m = p.match(
        new RegExp(`^${escape(prefix)}([^/]+?)${escape(suffixRoot)}(?:/|$)`),
      );
    } else {
      m = p.match(new RegExp(`^${escape(t)}/([^/]+)(?:/|$)`));
    }
    return validId(m?.[1]);
  };
  if (syncFiles.localProjects) {
    const id = idUnder(syncFiles.localProjects, "[project_id]");
    if (id != null) return id;
  }
  if (syncFiles.local) {
    const m = p.match(
      new RegExp(
        `^${escape(posix.normalize(join(syncFiles.local, "projects")))}/([^/]+)(?:/|$)`,
      ),
    );
    const id = validId(m?.[1]);
    if (id != null) return id;
  }
  if (syncFiles.localHosts && idUnder(syncFiles.localHosts, "[host_id]") != null) {
    return "host";
  }
  if (
    syncFiles.localAccounts &&
    idUnder(syncFiles.localAccounts, "[account_id]") != null
  ) {
    return "host";
  }
  return [syncFiles.local, syncFiles.localHub].some((r) => r && under(r))
    ? "host"
    : undefined;
}

function maintenanceScope(storagePath: string): {
  scopeType: PersistMaintenanceScopeType;
  scopeId?: string;
} {
  for (const [prefix, scopeType] of [
    ["projects", "project"],
    ["accounts", "account"],
    ["hosts", "host"],
  ] as const) {
    const match = storagePath.match(new RegExp(`^${prefix}/([^/]+)`));
    if (match) return { scopeType, scopeId: match[1] };
  }
  if (storagePath === "hub" || storagePath.startsWith("hub/")) {
    return { scopeType: "hub" };
  }
  return { scopeType: "other" };
}

export async function getStream({
  subject,
  storage,
  service,
  maintenance,
}: {
  subject: string;
  storage: StorageOptions;
  service?: string;
  maintenance?: PersistMaintenanceHooks;
}): Promise<PersistentStream> {
  // this permsissions check should always work and use should
  // never see an error here, since
  // the same check runs on the client before the message is sent to the
  // persist storage.  However a malicious user would hit this.
  // IMPORTANT: must be here so error *code* also sent back.
  assertHasWritePermission({
    subject,
    path: storage.path,
    service,
  });
  // While a project is fenced its disk-backed streams wait here, and once its
  // files were replaced they report a new instance (project-fence.ts).
  const project_id = storage.ephemeral
    ? undefined
    : projectOfStoragePath(storage.path);
  if (project_id == null) {
    return await openStream({ storage, maintenance });
  }
  const leave = await enterProjectOpen(project_id);
  try {
    const stream = await openStream({ storage, maintenance });
    const replaced = projectReplacedInstance(project_id);
    if (replaced != null) {
      stream.replacedInstance = replaced;
    }
    return stream;
  } finally {
    leave();
  }
}

async function openStream({
  storage,
  maintenance,
}: {
  storage: StorageOptions;
  maintenance?: PersistMaintenanceHooks;
}): Promise<PersistentStream> {
  // Project/host/account paths can be redirected to per-subject roots.
  const ephemeral = !!storage.ephemeral;
  const store = ephemeral ? undefined : projectStoreRoot(storage.path);
  if (store != null) {
    await prepareProjectStore(store);
  }
  const path = resolveLocalPath(storage.path, { ephemeral });
  const archive =
    !ephemeral && syncFiles.archive
      ? join(syncFiles.archive, storage.path)
      : undefined;
  const backup =
    !ephemeral && syncFiles.backup
      ? join(syncFiles.backup, storage.path)
      : undefined;
  const archiveInterval = ephemeral ? undefined : syncFiles.archiveInterval;
  if (!ephemeral) {
    await Promise.all(
      [path, archive, backup]
        .filter((x) => x)
        .map(ensureContainingDirectoryExists),
    );
  }
  if (ephemeral) {
    return pstream({ ...storage, path, archive, backup, archiveInterval });
  }
  if (maintenance == null) {
    // 028 B-2: the open barrier, off the main thread, right before the get
    // (no await between it and the construction that consumes its pass)
    await prepareDurableOpen(path, storeOwner(storage.path), store?.root);
    try {
      return pstream({ ...storage, path, archive, backup, archiveInterval });
    } finally {
      clearOpenBarrierPass(path);
    }
  }

  const maintenancePath: PersistMaintenancePath = {
    logicalPath: storage.path,
    physicalPath: `${path}.db`,
    archivePath: archive ? `${archive}.db` : undefined,
    backupPath: backup ? `${backup}.db` : undefined,
    ...maintenanceScope(storage.path),
  };
  let handle;
  try {
    handle = await maintenance.beginOpen(maintenancePath);
  } catch (err) {
    // Catalog/coordinator failures must never make persist unavailable. The
    // hook is responsible for dropping worker coverage so promotion remains
    // fail-closed while this untracked handle exists.
    maintenance.trackingUnavailable?.(err);
  }
  try {
    await prepareDurableOpen(path, storeOwner(storage.path), store?.root);
    const stream = pstream({
      ...storage,
      path,
      archive,
      backup,
      archiveInterval,
    });
    if (handle != null) {
      // This is needed on cache hits: the handle in constructor options came
      // from the first reference, but every later tracked use shares it.
      stream.addMaintenanceHandle(handle);
    }
    return stream;
  } catch (err) {
    maintenance.openFailed?.(maintenancePath, err);
    throw err;
  } finally {
    clearOpenBarrierPass(path);
  }
}

// the logical owner of a storage path, for the open barrier's fairness
function storeOwner(logicalPath: string): string {
  return projectOfStoragePath(logicalPath) ?? "host";
}
