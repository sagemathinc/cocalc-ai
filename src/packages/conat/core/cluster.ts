import { type Client, connect } from "./client";
import { Patterns } from "./patterns";
import { updateInterest, type InterestUpdate } from "@cocalc/conat/core/server";
import type { DStream } from "@cocalc/conat/sync/dstream";
import { server as createPersistServer } from "@cocalc/conat/persist/server";
import { getLogger } from "@cocalc/conat/logger";
import { hash_string } from "@cocalc/util/misc";
import { sysApi } from "./sys";
const CREATE_LINK_TIMEOUT = 45_000;
const INTEREST_SNAPSHOT_INTERVAL = 30_000;
const MAX_RECENT_INTEREST_UPDATES = 100_000;

const logger = getLogger("conat:core:cluster");

function unrefDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as any).unref?.();
  });
}

export async function clusterLink(
  address: string,
  systemAccountPassword: string,
  timeout = CREATE_LINK_TIMEOUT,
) {
  const client = connect({ address, systemAccountPassword });
  if (client.info == null) {
    try {
      await client.waitUntilSignedIn({
        timeout: timeout ?? CREATE_LINK_TIMEOUT,
      });
    } catch (err) {
      client.close();
      throw err;
    }
    if (client.info == null) {
      // this is impossible
      throw Error("BUG -- failed to sign in");
    }
  }
  const { id, clusterName } = client.info;
  if (!id) {
    throw Error("id must be specified");
  }
  if (!clusterName) {
    throw Error("clusterName must be specified");
  }
  const link = new ClusterLink(client, id, clusterName, address);
  await link.init();
  return link;
}

export type Interest = Patterns<{ [queue: string]: Set<string> }>;
export type SerializedInterest = {
  version: number;
  subjects: {
    [subject: string]: { [queue: string]: string[] };
  };
};

export function serializeInterest(
  interest: Interest,
  version = 0,
): SerializedInterest {
  return {
    version,
    subjects: interest.serialize((groups) => {
      const serialized: { [queue: string]: string[] } = {};
      for (const queue in groups) {
        serialized[queue] = Array.from(groups[queue]).sort();
      }
      return serialized;
    }).patterns,
  };
}

export function replaceInterest(
  interest: Interest,
  snapshot: SerializedInterest,
): void {
  const next: Interest = new Patterns();
  for (const subject in snapshot.subjects) {
    const groups: { [queue: string]: Set<string> } = {};
    for (const queue in snapshot.subjects[subject]) {
      groups[queue] = new Set(snapshot.subjects[subject][queue]);
    }
    next.set(subject, groups);
  }
  interest.deserialize(next.serialize());
}

export { type ClusterLink };

class ClusterLink {
  public interest: Interest = new Patterns();
  private streams: ClusterStreams;
  private state: "init" | "ready" | "closed" = "init";
  private clientStateChanged = Date.now(); // when client status last changed
  private interestSnapshotLoopStarted = false;
  private interestVersion = 0;
  private recentInterestUpdates: InterestUpdate[] = [];

  constructor(
    public readonly client: Client,
    public readonly id: string,
    public readonly clusterName: string,
    public readonly address: string,
  ) {
    if (!client) {
      throw Error("client must be specified");
    }
    if (!clusterName) {
      throw Error("clusterName must be specified");
    }
    if (!id) {
      throw Error("id must be specified");
    }
  }

  init = async () => {
    this.client.on("connected", this.handleClientStateChanged);
    this.client.on("disconnected", this.handleClientStateChanged);
    this.streams = await clusterStreams({
      client: this.client,
      id: this.id,
      clusterName: this.clusterName,
    });
    for (const update of this.streams.interest.getAll()) {
      this.handleInterestUpdate(update);
    }
    await this.reconcileInterestSnapshot("init");
    // I have a slight concern about this because updates might not
    // arrive in order during automatic failover.  That said, maybe
    // automatic failover doesn't matter with these streams, since
    // it shouldn't really happen -- each stream is served from the server
    // it is about, and when that server goes down none of this state
    // matters anymore.
    this.streams.interest.on("change", this.handleInterestUpdate);
    this.state = "ready";
    this.startInterestSnapshotLoop();
  };

  isConnected = () => {
    return this.client.state == "connected";
  };

  handleInterestUpdate = (update: InterestUpdate) => {
    const { version } = update;
    if (version == null) {
      if (this.interestVersion > 0) {
        return;
      }
      updateInterest(update, this.interest);
      return;
    }
    if (version <= this.interestVersion) {
      return;
    }
    updateInterest(update, this.interest);
    this.interestVersion = version;
    this.rememberInterestUpdate(update);
  };

  private rememberInterestUpdate = (update: InterestUpdate) => {
    if (update.version == null) {
      return;
    }
    this.recentInterestUpdates.push(update);
    if (this.recentInterestUpdates.length > MAX_RECENT_INTEREST_UPDATES) {
      this.recentInterestUpdates.splice(
        0,
        this.recentInterestUpdates.length - MAX_RECENT_INTEREST_UPDATES,
      );
    }
  };

  private replayUpdatesAfterSnapshot = (
    snapshot: SerializedInterest,
    currentVersion: number,
  ): InterestUpdate[] | undefined => {
    if (snapshot.version >= currentVersion) {
      return [];
    }
    const byVersion = new Map<number, InterestUpdate>();
    for (const update of this.recentInterestUpdates) {
      if (
        update.version != null &&
        update.version > snapshot.version &&
        update.version <= currentVersion
      ) {
        byVersion.set(update.version, update);
      }
    }
    const updates: InterestUpdate[] = [];
    for (
      let version = snapshot.version + 1;
      version <= currentVersion;
      version++
    ) {
      const update = byVersion.get(version);
      if (update == null) {
        return;
      }
      updates.push(update);
    }
    return updates;
  };

  private applyInterestSnapshot = (snapshot: SerializedInterest): boolean => {
    const currentVersion = this.interestVersion;
    const replayUpdates = this.replayUpdatesAfterSnapshot(
      snapshot,
      currentVersion,
    );
    if (replayUpdates == null) {
      return false;
    }
    replaceInterest(this.interest, snapshot);
    this.interestVersion = snapshot.version;
    for (const update of replayUpdates) {
      updateInterest(update, this.interest);
      this.interestVersion = update.version ?? this.interestVersion;
    }
    return true;
  };

  private handleClientStateChanged = () => {
    this.clientStateChanged = Date.now();
    if (this.isConnected()) {
      void this.reconcileInterestSnapshot("connected");
    }
  };

  private reconcileInterestSnapshot = async (reason: string) => {
    if (this.state == "closed" || !this.isConnected()) {
      return;
    }
    try {
      const snapshot = await sysApi(this.client, {
        timeout: 15_000,
        waitForInterest: true,
      }).interestSnapshot();
      if (!this.applyInterestSnapshot(snapshot)) {
        logger.debug(
          "interest snapshot reconciliation skipped because delta replay was incomplete",
          {
            id: this.id,
            clusterName: this.clusterName,
            address: this.address,
            reason,
            snapshotVersion: snapshot.version,
            interestVersion: this.interestVersion,
            recentInterestUpdates: this.recentInterestUpdates.length,
          },
        );
      }
    } catch (err) {
      logger.debug("interest snapshot reconciliation failed", {
        id: this.id,
        clusterName: this.clusterName,
        address: this.address,
        reason,
        err,
      });
    }
  };

  private startInterestSnapshotLoop = () => {
    if (this.interestSnapshotLoopStarted) {
      return;
    }
    this.interestSnapshotLoopStarted = true;
    const loop = async () => {
      while (this.state != "closed") {
        await unrefDelay(INTEREST_SNAPSHOT_INTERVAL);
        await this.reconcileInterestSnapshot("periodic");
      }
    };
    void loop();
  };

  howLongDisconnected = () => {
    if (this.isConnected()) {
      return 0;
    }
    return Date.now() - this.clientStateChanged;
  };

  close = () => {
    if (this.state == "closed") {
      return;
    }
    this.state = "closed";
    this.client.removeListener("connected", this.handleClientStateChanged);
    this.client.removeListener("disconnected", this.handleClientStateChanged);
    if (this.streams != null) {
      this.streams.interest.removeListener("change", this.handleInterestUpdate);
      this.streams.interest.close();
      // @ts-ignore
      delete this.streams;
    }
    this.client.close();
    // @ts-ignore
    delete this.client;
  };

  hasInterest = (subject) => {
    return this.interest.hasMatch(subject);
  };

  waitForInterest = async (
    subject: string,
    timeout: number,
    signal?: AbortSignal,
  ) => {
    const hasMatch = this.interest.hasMatch(subject);

    if (hasMatch || !timeout) {
      // NOTE: we never return the actual matches, since this is a
      // potential security vulnerability.
      // it could make it very easy to figure out private inboxes, etc.
      return hasMatch;
    }
    const start = Date.now();
    while (this.state != "closed" && !signal?.aborted) {
      if (Date.now() - start >= timeout) {
        throw Error("timeout");
      }
      await this.interest.waitForChange();
      if ((this.state as any) == "closed" || signal?.aborted) {
        return false;
      }
      const hasMatch = this.interest.hasMatch(subject);
      if (hasMatch) {
        return true;
      }
    }

    return false;
  };

  hash = (): { interest: number } => {
    return {
      interest: hashInterest(this.interest),
    };
  };
}

function clusterStreamNames({
  clusterName,
  id,
}: {
  clusterName: string;
  id: string;
}) {
  return {
    interest: `cluster/${clusterName}/${id}/interest`,
  };
}

export function clusterService({
  id,
  clusterName,
}: {
  id: string;
  clusterName: string;
}) {
  return `persist:${clusterName}:${id}`;
}

export async function createClusterPersistServer({
  client,
  id,
  clusterName,
}: {
  client: Client;
  id: string;
  clusterName: string;
}) {
  const service = clusterService({ clusterName, id });
  logger.debug("createClusterPersistServer: ", { service });
  return await createPersistServer({ client, service });
}

export interface ClusterStreams {
  interest: DStream<InterestUpdate>;
}

export async function clusterStreams({
  client,
  clusterName,
  id,
}: {
  client: Client;
  clusterName: string;
  id: string;
}): Promise<ClusterStreams> {
  logger.debug("clusterStream: ", { clusterName, id });
  if (!clusterName) {
    throw Error("clusterName must be set");
  }
  const names = clusterStreamNames({ clusterName, id });
  const opts = {
    service: clusterService({ clusterName, id }),
    noCache: true,
    ephemeral: true,
  };
  const interest = await client.sync.dstream<InterestUpdate>({
    noInventory: true,
    name: names.interest,
    ...opts,
  });
  logger.debug("clusterStreams: got them", { clusterName });
  return { interest };
}

// Periodically delete not-necessary updates from the interest stream
export async function trimClusterStreams(
  streams: ClusterStreams,
  data: {
    interest: Patterns<{ [queue: string]: Set<string> }>;
    links: { interest: Patterns<{ [queue: string]: Set<string> }> }[];
  },
  // don't delete anything that isn't at lest minAge ms old.
  minAge: number,
): Promise<{ seqsInterest: number[] }> {
  const { interest } = streams;
  // First deal with interst
  // we iterate over the interest stream checking for subjects
  // with no current interest at all; in such cases it is safe
  // to purge them entirely from the stream.
  const seqs: number[] = [];
  const now = Date.now();
  for (let n = 0; n < interest.length; n++) {
    const time = interest.time(n);
    if (time == null) continue;
    if (now - time.valueOf() <= minAge) {
      break;
    }
    const update = interest.get(n) as InterestUpdate;
    if (!data.interest.hasPattern(update.subject)) {
      const seq = interest.seq(n);
      if (seq != null) {
        seqs.push(seq);
      }
    }
  }
  if (seqs.length > 0) {
    // [ ] todo -- add to interest.delete a version where it takes an array of sequence numbers
    logger.debug("trimClusterStream: trimming interest", { seqs });
    await interest.delete({ seqs });
    logger.debug("trimClusterStream: successfully trimmed interest", { seqs });
  }
  return { seqsInterest: seqs };
}

function hashSet(X: Set<string>): number {
  let h = 0;
  for (const a of X) {
    h += hash_string(a); // integers, and not too many, so should commute
  }
  return h;
}

function hashInterestValue(X: { [queue: string]: Set<string> }): number {
  let h = 0;
  for (const queue in X) {
    h += hashSet(X[queue]); // integers, and not too many, so should commute
  }
  return h;
}

export function hashInterest(
  interest: Patterns<{ [queue: string]: Set<string> }>,
): number {
  return interest.hash(hashInterestValue);
}
