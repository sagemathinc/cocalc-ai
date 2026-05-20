import { type Client, connect } from "./client";
import { Patterns } from "./patterns";
import { updateInterest, type InterestUpdate } from "@cocalc/conat/core/server";
import { getLogger } from "@cocalc/conat/logger";
import { hash_string } from "@cocalc/util/misc";
const CREATE_LINK_TIMEOUT = 45_000;
const INTEREST_SNAPSHOT_INTERVAL = 30_000;
const MAX_RECENT_INTEREST_UPDATES = 100_000;
const CLUSTER_INTEREST_RPC_TIMEOUT = 15_000;

const logger = getLogger("conat:core:cluster");

export const CLUSTER_INTEREST_PROTOCOL = 1;
export const CLUSTER_INTEREST_OPEN = "cluster-interest-open";
export const CLUSTER_INTEREST_DELTA = "cluster-interest-delta";
export const CLUSTER_INTEREST_SNAPSHOT_REQUEST =
  "cluster-interest-snapshot-request";
export const CLUSTER_INTEREST_CLOSE = "cluster-interest-close";

export interface ClusterInterestOpen {
  protocol: typeof CLUSTER_INTEREST_PROTOCOL;
  clusterName: string;
  nodeId?: string;
  knownVersion?: number;
}

export type ClusterInterestOpenResponse =
  | { ok: true; snapshot: SerializedInterest }
  | { ok: false; error: string; code?: number };

export type ClusterInterestSnapshotRequestReason =
  | "bootstrap"
  | "gap"
  | "periodic"
  | "stale"
  | "reconnect"
  | "debug"
  | "connected"
  | "init"
  | "test";

export interface ClusterInterestSnapshotRequest {
  protocol: typeof CLUSTER_INTEREST_PROTOCOL;
  reason: ClusterInterestSnapshotRequestReason;
  currentVersion?: number;
}

export type ClusterInterestSnapshotResponse =
  | { ok: true; snapshot: SerializedInterest }
  | { ok: false; error: string; code?: number };

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
  localId?: string,
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
  const link = new ClusterLink(client, id, clusterName, address, localId);
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
  private state: "init" | "ready" | "closed" = "init";
  private clientStateChanged = Date.now(); // when client status last changed
  private interestSnapshotLoopStarted = false;
  private interestVersion = 0;
  private recentInterestUpdates: InterestUpdate[] = [];
  private openInterestPromise?: Promise<void>;

  constructor(
    public readonly client: Client,
    public readonly id: string,
    public readonly clusterName: string,
    public readonly address: string,
    public readonly localId?: string,
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
    this.client.conn.on(CLUSTER_INTEREST_DELTA, this.handleDirectInterestDelta);
    await this.openDirectInterest("init");
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
    this.rememberInterestUpdate(update);
    if (version > this.interestVersion + 1) {
      logger.debug("cluster interest delta gap detected", {
        id: this.id,
        clusterName: this.clusterName,
        expectedVersion: this.interestVersion + 1,
        receivedVersion: version,
      });
      void this.reconcileInterestSnapshot("gap");
      return;
    }
    updateInterest(update, this.interest);
    this.interestVersion = version;
  };

  private handleDirectInterestDelta = (update: InterestUpdate) => {
    if (this.state == "closed") {
      return;
    }
    this.handleInterestUpdate(update);
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

  private highestKnownInterestVersion = () => {
    let version = this.interestVersion;
    for (const update of this.recentInterestUpdates) {
      if (update.version != null && update.version > version) {
        version = update.version;
      }
    }
    return version;
  };

  private replayUpdatesAfterSnapshot = (
    snapshot: SerializedInterest,
  ): InterestUpdate[] | undefined => {
    const targetVersion = this.highestKnownInterestVersion();
    if (snapshot.version >= targetVersion) {
      return [];
    }
    const byVersion = new Map<number, InterestUpdate>();
    for (const update of this.recentInterestUpdates) {
      if (
        update.version != null &&
        update.version > snapshot.version &&
        update.version <= targetVersion
      ) {
        byVersion.set(update.version, update);
      }
    }
    const updates: InterestUpdate[] = [];
    for (
      let version = snapshot.version + 1;
      version <= targetVersion;
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
    const replayUpdates = this.replayUpdatesAfterSnapshot(snapshot);
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
      void this.openDirectInterest("connected");
    }
  };

  private openDirectInterest = async (
    reason: ClusterInterestSnapshotRequestReason,
  ) => {
    if (this.openInterestPromise != null) {
      await this.openInterestPromise;
      return;
    }
    this.openInterestPromise = this.openDirectInterest0(reason);
    try {
      await this.openInterestPromise;
    } finally {
      this.openInterestPromise = undefined;
    }
  };

  private openDirectInterest0 = async (
    reason: ClusterInterestSnapshotRequestReason,
  ) => {
    if (this.state == "closed" || !this.isConnected()) {
      return;
    }
    try {
      const response: ClusterInterestOpenResponse = await this.client.conn
        .timeout(CLUSTER_INTEREST_RPC_TIMEOUT)
        .emitWithAck(CLUSTER_INTEREST_OPEN, {
          protocol: CLUSTER_INTEREST_PROTOCOL,
          clusterName: this.clusterName,
          nodeId: this.localId,
          knownVersion: this.interestVersion,
        } satisfies ClusterInterestOpen);
      if (!response?.ok) {
        throw Error(response?.error ?? "failed to open cluster interest link");
      }
      if (!this.applyInterestSnapshot(response.snapshot)) {
        logger.debug(
          "cluster interest open snapshot skipped because delta replay was incomplete",
          {
            id: this.id,
            clusterName: this.clusterName,
            address: this.address,
            reason,
            snapshotVersion: response.snapshot.version,
            interestVersion: this.interestVersion,
            recentInterestUpdates: this.recentInterestUpdates.length,
          },
        );
      }
    } catch (err) {
      logger.debug("cluster interest open failed", {
        id: this.id,
        clusterName: this.clusterName,
        address: this.address,
        reason,
        err,
      });
      if (reason == "init") {
        throw err;
      }
    }
  };

  private requestDirectInterestSnapshot = async (
    reason: ClusterInterestSnapshotRequestReason,
  ): Promise<SerializedInterest> => {
    const response: ClusterInterestSnapshotResponse = await this.client.conn
      .timeout(CLUSTER_INTEREST_RPC_TIMEOUT)
      .emitWithAck(CLUSTER_INTEREST_SNAPSHOT_REQUEST, {
        protocol: CLUSTER_INTEREST_PROTOCOL,
        reason,
        currentVersion: this.interestVersion,
      } satisfies ClusterInterestSnapshotRequest);
    if (!response?.ok) {
      throw Error(response?.error ?? "failed to get cluster interest snapshot");
    }
    return response.snapshot;
  };

  private reconcileInterestSnapshot = async (
    reason: ClusterInterestSnapshotRequestReason,
  ) => {
    if (this.state == "closed" || !this.isConnected()) {
      return;
    }
    try {
      const snapshot = await this.requestDirectInterestSnapshot(reason);
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
    this.client.conn.off(
      CLUSTER_INTEREST_DELTA,
      this.handleDirectInterestDelta,
    );
    this.client.conn.emit(CLUSTER_INTEREST_CLOSE, {
      protocol: CLUSTER_INTEREST_PROTOCOL,
      clusterName: this.clusterName,
      nodeId: this.localId,
    });
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
