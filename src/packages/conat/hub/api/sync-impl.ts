import { patchesStreamName } from "@cocalc/conat/sync/synctable-stream";
import { type Patch, type HistoryInfo } from "@cocalc/conat/hub/api/sync";
import { client_db } from "@cocalc/util/db-schema/client-db";

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

export async function purgeHistory({
  account_id,
  project_id,
  path,
  client,
  assertAccess,
}: {
  account_id?: string;
  project_id: string;
  path: string;
  client?: any;
  assertAccess?: AssertAccessFn;
}): Promise<{ deleted: number; history_epoch: number }> {
  await assertAccess?.({ account_id, project_id });

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
    // Open documents keep their settings, including history_epoch, in the
    // patch stream's metadata (not in the syncstrings table above), so the
    // new epoch must be published there too.
    const metadata = (await stream.getMetadata()) as
      | { settings?: Record<string, any> }
      | undefined;
    const metadataSettings = (
      metadata != null && typeof metadata === "object" ? metadata.settings : {}
    ) as Record<string, any>;
    const epochOf = (x: Record<string, any> | undefined) =>
      typeof x?.history_epoch === "number" && Number.isFinite(x.history_epoch)
        ? x.history_epoch
        : 0;
    const history_epoch =
      Math.max(epochOf(settings), epochOf(metadataSettings)) + 1;
    const history_purged_at = Date.now();
    // 1. fence: writes still carrying an older epoch are rejected
    await stream.config({
      required_headers: { history_epoch },
    });
    // 2. publish the new epoch, before deleting anything: open copies of the
    // document see it, emit "history-reset" and close, rather than react to
    // their history disappearing; new opens write with the new epoch.
    await stream.patchMetadata({
      settings: {
        ...(metadataSettings ?? {}),
        history_epoch,
        history_purged_at,
        history_purged_by: account_id ?? null,
      },
    });
    // 3. delete the history
    const deleted = await stream.delete({ all: true });
    const nextSettings = {
      ...settings,
      history_epoch,
      history_purged_at,
      history_purged_by: account_id ?? null,
    };
    syncstrings.set({
      ...current,
      string_id,
      project_id,
      path,
      last_snapshot: null,
      last_seq: null,
      settings: nextSettings,
    });
    await syncstrings.save();

    return {
      deleted: deleted.seqs?.length ?? 0,
      history_epoch,
    };
  } finally {
    stream.close();
    syncstrings.close();
  }
}
