/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { before, after, wait } from "@cocalc/backend/conat/test/setup";
import { randomId } from "@cocalc/conat/names";
import { Patterns } from "@cocalc/conat/core/patterns";
import { createClusterNode } from "./util";
import {
  CLUSTER_INTEREST_DELTA,
  serializeInterest,
} from "@cocalc/conat/core/cluster";

beforeAll(before);
afterAll(after);

jest.setTimeout(20000);

describe("cluster interest snapshot reconciliation", () => {
  const nodes: Awaited<ReturnType<typeof createClusterNode>>[] = [];

  afterEach(async () => {
    for (const { client, server } of nodes.splice(0, nodes.length)) {
      try {
        client.close();
      } catch {}
      try {
        await server.close();
      } catch {}
    }
  });

  it("repairs a link whose derived interest state missed an update", async () => {
    const clusterName = `cluster-snapshot-${randomId()}`;
    const nodeA = await createClusterNode({ clusterName, id: "a" });
    const nodeB = await createClusterNode({ clusterName, id: "b" });
    nodes.push(nodeA, nodeB);
    await nodeA.server.join(nodeB.server.address());

    const subject = `snapshot.${randomId()}`;
    const sub = await nodeB.client.subscribe(subject);
    const link = (nodeA.server as any).clusterLinks[clusterName].b;

    await wait({ until: () => link.hasInterest(subject) });

    link.interest = new Patterns();
    expect(link.hasInterest(subject)).toBe(false);

    await link.reconcileInterestSnapshot("test");

    expect(link.hasInterest(subject)).toBe(true);
    sub.close();
  });

  it("bootstraps a link from an existing direct interest snapshot", async () => {
    const clusterName = `cluster-snapshot-${randomId()}`;
    const nodeA = await createClusterNode({ clusterName, id: "a" });
    const nodeB = await createClusterNode({ clusterName, id: "b" });
    nodes.push(nodeA, nodeB);

    const subject = `bootstrap.${randomId()}`;
    const sub = await nodeB.client.subscribe(subject);

    await nodeA.server.join(nodeB.server.address());
    const link = (nodeA.server as any).clusterLinks[clusterName].b;

    expect(link.hasInterest(subject)).toBe(true);
    sub.close();
  });

  it("detects a missed direct delta and repairs from a snapshot", async () => {
    const clusterName = `cluster-snapshot-${randomId()}`;
    const nodeA = await createClusterNode({ clusterName, id: "a" });
    const nodeB = await createClusterNode({ clusterName, id: "b" });
    nodes.push(nodeA, nodeB);
    await nodeA.server.join(nodeB.server.address());

    const link = (nodeA.server as any).clusterLinks[clusterName].b;
    const handler = link.handleDirectInterestDelta;
    const missedSubject = `missed.${randomId()}`;
    const laterSubject = `later.${randomId()}`;

    link.client.conn.off(CLUSTER_INTEREST_DELTA, handler);
    const missedSub = await nodeB.client.subscribe(missedSubject);
    await wait({ until: () => !link.hasInterest(missedSubject), timeout: 250 });

    link.client.conn.on(CLUSTER_INTEREST_DELTA, handler);
    const laterSub = await nodeB.client.subscribe(laterSubject);

    await wait({
      until: () =>
        link.hasInterest(missedSubject) && link.hasInterest(laterSubject),
    });

    missedSub.close();
    laterSub.close();
  });

  it("applies a snapshot and replays newer deltas that arrived while the snapshot was in flight", async () => {
    const clusterName = `cluster-snapshot-${randomId()}`;
    const nodeA = await createClusterNode({ clusterName, id: "a" });
    const nodeB = await createClusterNode({ clusterName, id: "b" });
    nodes.push(nodeA, nodeB);
    await nodeA.server.join(nodeB.server.address());

    const link = (nodeA.server as any).clusterLinks[clusterName].b;
    const snapshotSubject = `snapshot.${randomId()}`;
    const laterSubject = `later.${randomId()}`;

    const snapshotSub = await nodeB.client.subscribe(snapshotSubject);
    await wait({ until: () => link.hasInterest(snapshotSubject) });

    const snapshot = serializeInterest(
      nodeB.server.interest,
      (nodeB.server as any).interestVersion,
    );

    const laterSub = await nodeB.client.subscribe(laterSubject);
    await wait({ until: () => link.hasInterest(laterSubject) });

    link.interest = new Patterns();
    expect(link.hasInterest(snapshotSubject)).toBe(false);
    expect(link.hasInterest(laterSubject)).toBe(false);

    expect(link.applyInterestSnapshot(snapshot)).toBe(true);

    expect(link.hasInterest(snapshotSubject)).toBe(true);
    expect(link.hasInterest(laterSubject)).toBe(true);

    snapshotSub.close();
    laterSub.close();
  });

  it("skips an old snapshot when buffered replay is incomplete", async () => {
    const clusterName = `cluster-snapshot-${randomId()}`;
    const nodeA = await createClusterNode({ clusterName, id: "a" });
    const nodeB = await createClusterNode({ clusterName, id: "b" });
    nodes.push(nodeA, nodeB);
    await nodeA.server.join(nodeB.server.address());

    const link = (nodeA.server as any).clusterLinks[clusterName].b;
    const snapshotSubject = `snapshot.${randomId()}`;
    const laterSubject = `later.${randomId()}`;

    const snapshotSub = await nodeB.client.subscribe(snapshotSubject);
    await wait({ until: () => link.hasInterest(snapshotSubject) });

    const snapshot = serializeInterest(
      nodeB.server.interest,
      (nodeB.server as any).interestVersion,
    );

    const laterSub = await nodeB.client.subscribe(laterSubject);
    await wait({ until: () => link.hasInterest(laterSubject) });

    link.recentInterestUpdates = link.recentInterestUpdates.filter(
      (update) => update.version == null || update.version <= snapshot.version,
    );

    expect(link.applyInterestSnapshot(snapshot)).toBe(false);
    expect(link.hasInterest(snapshotSubject)).toBe(true);
    expect(link.hasInterest(laterSubject)).toBe(true);

    snapshotSub.close();
    laterSub.close();
  });
});
