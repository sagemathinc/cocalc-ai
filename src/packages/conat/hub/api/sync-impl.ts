import { patchesStreamName } from "@cocalc/conat/sync/synctable-stream";
import {
  type Patch,
  type HistoryInfo,
  type PurgeHistoryResult,
} from "@cocalc/conat/hub/api/sync";
import { client_db } from "@cocalc/util/db-schema/client-db";
import { retryWhileResetBusy } from "@cocalc/conat/persist/reset-busy";
import type { ResetHistoryResult } from "@cocalc/conat/persist/storage";

type AssertAccessFn = (opts: {
  account_id?: string;
  project_id: string;
}) => Promise<void> | void;

function requireExplicitConatClient(client?: any) {
  if (client?.sync != null) {
    return client;
  }
  if (typeof client?.conat === "function") {
    const raw = client.conat();
    if (raw?.sync != null) {
      return raw;
    }
  }
  throw new Error("must provide an explicit Conat client");
}

export async function history({
  account_id,
  project_id,
  path,
  start_seq = 0,
  end_seq,
  client,
  assertAccess,
}: {
  account_id?: string;
  project_id: string;
  path: string;
  start_seq?: number;
  end_seq?: number;
  client?: any;
  assertAccess?: AssertAccessFn;
}): Promise<{ patches: Patch[]; info: HistoryInfo }> {
  await assertAccess?.({ account_id, project_id });

  // Shared sync helpers are used by both lite and server control-plane code.
  // Require an explicit client here so backend callers do not silently route
  // through whichever global Conat singleton happens to be initialized.
  const conatClient = requireExplicitConatClient(client);
  const name = patchesStreamName({ path });
  const astream = conatClient.sync.astream({
    name,
    project_id,
    noInventory: true,
  });
  const akv = conatClient.sync.akv({
    name: `__dko__syncstrings:${client_db.sha1(project_id, path)}`,
    project_id,
    noInventory: true,
  });
  try {
    const patches: Patch[] = [];
    for await (const patch of await astream.getAll({
      start_seq,
      end_seq,
    })) {
      patches.push(patch as any);
    }

    const keys = await akv.keys();
    const info: Partial<HistoryInfo> = {};
    for (const key of keys) {
      if (key[0] != "[") continue;
      info[JSON.parse(key)[1]] = await akv.get(key);
    }

    return { patches, info: info as HistoryInfo };
  } finally {
    astream.close();
    akv.close();
  }
}

// Reset a document's edit history (TimeTravel's "purge history").  The patch
// stream does it in one transaction -- fence out writes of older epochs,
// publish the new history_epoch in its metadata (open copies of the document
// then close), and delete the old patches -- so concurrent purges and writers
// cannot interleave.
//
// With oversized_seq, this is the automatic reset of a history holding a
// patch too large to load (the 413 from opening the document says which):
// it only happens if that patch is still there, and the old history is kept
// in the stream rather than deleted.  So when several clients hit the same
// oversized patch at once, only the first resets the history.
export async function purgeHistory({
  account_id,
  project_id,
  path,
  oversized_seq,
  client,
  assertAccess,
}: {
  account_id?: string;
  project_id: string;
  path: string;
  oversized_seq?: number;
  client?: any;
  assertAccess?: AssertAccessFn;
}): Promise<PurgeHistoryResult> {
  await assertAccess?.({ account_id, project_id });
  if (
    oversized_seq != null &&
    !(typeof oversized_seq == "number" && Number.isSafeInteger(oversized_seq))
  ) {
    throw new Error("oversized_seq must be an integer");
  }

  const conatClient = requireExplicitConatClient(client);
  const string_id = client_db.sha1(project_id, path);
  const name = patchesStreamName({ path });

  const syncstrings = await conatClient.sync.synctable({
    query: {
      syncstrings: [
        {
          string_id,
          project_id,
          path,
          users: null,
          last_snapshot: null,
          last_seq: null,
          snapshot_interval: null,
          save: null,
          last_active: null,
          init: null,
          read_only: null,
          last_file_change: null,
          doctype: null,
          archived: null,
          settings: null,
        },
      ],
    },
    stream: false,
    atomic: false,
    immutable: false,
    noInventory: true,
  });

  const getOne = (syncstrings as any).get_one ?? (syncstrings as any).getOne;
  const current = ((typeof getOne === "function"
    ? getOne.call(syncstrings)
    : undefined) ?? {
    string_id,
    project_id,
    path,
    settings: {},
    doctype: JSON.stringify({ type: "string", patch_format: 0 }),
  }) as Record<string, any>;

  const settings = (current.settings ?? {}) as Record<string, any>;
  const stream = conatClient.sync.astream({
    name,
    project_id,
    noInventory: true,
  });
  try {
    const history_purged_at = Date.now();
    const history_purged_by = account_id ?? null;
    // while another reset of this history is in progress, wait for it
    const result: ResetHistoryResult = await retryWhileResetBusy(() =>
      stream.resetHistory({
        // an epoch recorded only in the legacy syncstrings table still counts
        minEpoch:
          typeof settings.history_epoch === "number" &&
          Number.isFinite(settings.history_epoch)
            ? settings.history_epoch
            : 0,
        settings: { history_purged_at, history_purged_by },
        ...(oversized_seq != null
          ? { ifOversizedSeq: oversized_seq, archive: true }
          : {}),
      }),
    );
    if (!result.reset && result.refused === "trash-pending") {
      // H1c §3.3: an earlier reset's trash is still being removed
      throw new Error(
        "an earlier reset of this file's history is still being cleaned up; try again in a minute",
      );
    }
    if (result.reset) {
      syncstrings.set({
        ...current,
        string_id,
        project_id,
        path,
        last_snapshot: null,
        last_seq: null,
        settings: {
          ...settings,
          history_epoch: result.history_epoch,
          history_purged_at,
          history_purged_by,
        },
      });
      await syncstrings.save();
    }
    // A history still being counted reports COUNT_PROBE_RECORDS + 1, meaning
    // "more than COUNT_PROBE_RECORDS": pass on that lower bound, marked as one.
    const inexact = result.reset && result.countExact === false;
    return {
      deleted: result.reset ? (inexact ? result.count - 1 : result.count) : 0,
      ...(inexact ? { deletedExact: false as const } : {}),
      history_epoch: result.history_epoch,
      reset: result.reset,
    };
  } finally {
    stream.close();
    syncstrings.close();
  }
}
