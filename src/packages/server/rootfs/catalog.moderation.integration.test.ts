/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";

const isAdminMock = jest.fn(async (_account_id: string) => false);
const eventMock = jest.fn(async (_event: any) => undefined);

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (account_id: string) => isAdminMock(account_id),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterRole: () => "standalone",
  getConfiguredClusterSeedBayId: () => undefined,
}));
jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: jest.fn(),
}));
jest.mock("@cocalc/server/rootfs/events", () => ({
  appendRootfsImageEvent: (event: any) => eventMock(event),
  listRecentRootfsImageEvents: jest.fn(async () => []),
}));
jest.mock("@cocalc/server/rootfs/rustic-repo-schema", () => ({
  ensureRootfsRusticRepoSchema: jest.fn(async () => undefined),
}));
jest.mock("@cocalc/server/membership/rootfs-limits", () => ({
  assertCanCreateOrUpdateRootfs: jest.fn(async () => undefined),
}));
jest.mock("@cocalc/server/cloud/rootfs-prepull", () => ({
  enqueueRootfsPrepullForRunningHosts: jest.fn(async () => undefined),
}));

import { saveRootfsImage } from "./catalog";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("RootFS catalog moderation flags", () => {
  const owner = randomUUID();
  const admin = randomUUID();

  beforeAll(async () => {
    await syncSchema({ rootfs_images: SCHEMA.rootfs_images });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    isAdminMock.mockImplementation(async (account_id) => account_id === admin);
  });

  const stored = async (image_id: string) =>
    (
      await getPool().query(
        `SELECT official, prepull, hidden, hidden_by, blocked, blocked_reason,
                blocked_by, label, runtime_image
         FROM rootfs_images WHERE image_id=$1`,
        [image_id],
      )
    ).rows[0];

  const save = (account_id: string, body: Record<string, unknown>) =>
    saveRootfsImage({
      account_id,
      body: {
        image: "docker.io/example/owner-image:1",
        label: "Owner image",
        ...body,
      } as any,
    }).catch((err) => {
      // The response entry lookup reads other catalog tables; the stored row
      // is what this test checks.
      if (/relation .* does not exist/.test(`${err}`)) return undefined;
      throw err;
    });

  it("an owner re-save keeps the admin's hide and block, and revokes curation", async () => {
    await save(owner, {});
    const { rows } = await getPool().query(
      "SELECT image_id FROM rootfs_images WHERE owner_id=$1",
      [owner],
    );
    const image_id = rows[0].image_id;
    await save(admin, {
      image_id,
      official: true,
      prepull: true,
      hidden: true,
      blocked: true,
      blocked_reason: "malware",
    });
    // The moderator recorded is the admin who acted, not the image owner.
    expect(await stored(image_id)).toMatchObject({
      official: true,
      prepull: true,
      hidden: true,
      hidden_by: admin,
      blocked: true,
      blocked_reason: "malware",
      blocked_by: admin,
    });

    eventMock.mockClear();
    await save(owner, {
      image_id,
      label: "Renamed by owner",
      official: false,
      prepull: false,
      hidden: false,
      blocked: false,
    });
    expect(await stored(image_id)).toMatchObject({
      label: "Renamed by owner",
      // An owner edit revokes admin curation...
      official: false,
      prepull: false,
      // ...but keeps admin moderation, with its attribution.
      hidden: true,
      hidden_by: admin,
      blocked: true,
      blocked_reason: "malware",
      blocked_by: admin,
    });
    // No moderation event is recorded for the owner's save.
    expect(eventMock.mock.calls.map(([event]) => event.event_type)).not.toEqual(
      expect.arrayContaining(["unhidden"]),
    );
    expect(eventMock.mock.calls.map(([event]) => event.event_type)).not.toEqual(
      expect.arrayContaining(["unblocked"]),
    );
  });

  it("an owner re-save without an image id (matched by image) keeps them too", async () => {
    const image = "docker.io/example/second:1";
    await save(owner, { image });
    const { rows } = await getPool().query(
      "SELECT image_id FROM rootfs_images WHERE owner_id=$1 AND runtime_image=$2",
      [owner, image],
    );
    const image_id = rows[0].image_id;
    await save(admin, { image_id, image, hidden: true });
    await save(owner, { image, label: "again" });
    expect(await stored(image_id)).toMatchObject({
      label: "again",
      hidden: true,
    });
  });

  it("an owner pointing an approved entry at another image loses official and prepull", async () => {
    const image = "docker.io/example/approved:1";
    await save(owner, { image });
    const { rows } = await getPool().query(
      "SELECT image_id FROM rootfs_images WHERE owner_id=$1 AND runtime_image=$2",
      [owner, image],
    );
    const image_id = rows[0].image_id;
    await save(admin, { image_id, image, official: true, prepull: true });
    expect(await stored(image_id)).toMatchObject({
      official: true,
      prepull: true,
    });
    await save(owner, {
      image_id,
      image: "docker.io/example/swapped:1",
      official: true,
      prepull: true,
    });
    expect(await stored(image_id)).toMatchObject({
      runtime_image: "docker.io/example/swapped:1",
      official: false,
      prepull: false,
    });
  });

  it("an admin can still clear the flags", async () => {
    const image = "docker.io/example/third:1";
    await save(owner, { image });
    const { rows } = await getPool().query(
      "SELECT image_id FROM rootfs_images WHERE owner_id=$1 AND runtime_image=$2",
      [owner, image],
    );
    const image_id = rows[0].image_id;
    await save(admin, { image_id, image, hidden: true, blocked: true });
    await save(admin, { image_id, image, hidden: false, blocked: false });
    expect(await stored(image_id)).toMatchObject({
      hidden: false,
      blocked: false,
    });
  });
});
