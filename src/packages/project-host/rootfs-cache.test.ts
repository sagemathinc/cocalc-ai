/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const mockTestImageCache = join(
  os.tmpdir(),
  `cocalc-rootfs-cache-test-${process.pid}`,
);

jest.mock("@cocalc/project-runner/run/rootfs-base", () => {
  const path = require("node:path");
  return {
    IMAGE_CACHE: mockTestImageCache,
    extractBaseImage: jest.fn(),
    imageCachePath: (image: string) =>
      path.join(mockTestImageCache, encodeURIComponent(image)),
    inspectFilePath: (image: string) =>
      path.join(mockTestImageCache, `.${encodeURIComponent(image)}.json`),
    preflightMetadataFilePath: (image: string) =>
      path.join(
        mockTestImageCache,
        `.${encodeURIComponent(image)}.preflight.json`,
      ),
  };
});

jest.mock("@cocalc/lite/hub/api", () => ({
  hubApi: {
    hosts: {
      getManagedRootfsReleaseArtifact: jest.fn(),
      recordManagedRootfsReleaseReplica: jest.fn(),
    },
  },
}));

jest.mock("./sqlite/projects", () => ({
  listProjects: jest.fn(() => []),
}));

import { ROOTFS_NORMALIZER_VERSION } from "@cocalc/project-runner/run/rootfs-normalize";
import {
  imageCachePath,
  preflightMetadataFilePath,
} from "@cocalc/project-runner/run/rootfs-base";
import { hubApi } from "@cocalc/lite/hub/api";

import {
  pullRootfsCacheEntry,
  withManagedRootfsPullInFlight,
} from "./rootfs-cache";

describe("rootfs-cache", () => {
  beforeEach(async () => {
    await rm(mockTestImageCache, {
      recursive: true,
      force: true,
      maxRetries: 3,
    });
    await mkdir(mockTestImageCache, { recursive: true });
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await rm(mockTestImageCache, {
      recursive: true,
      force: true,
      maxRetries: 3,
    });
  });

  it("dedupes concurrent managed RootFS pulls per image", async () => {
    const image = `cocalc.local/rootfs/${"a".repeat(64)}`;
    let resolves!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolves = resolve;
    });
    let calls = 0;

    const first = withManagedRootfsPullInFlight({
      image,
      fn: async () => {
        calls += 1;
        await gate;
        return 7;
      },
    });
    const second = withManagedRootfsPullInFlight({
      image,
      fn: async () => {
        calls += 1;
        return 9;
      },
    });

    expect(calls).toBe(1);
    resolves();

    await expect(Promise.all([first, second])).resolves.toEqual([7, 7]);

    await expect(
      withManagedRootfsPullInFlight({
        image,
        fn: async () => {
          calls += 1;
          return 11;
        },
      }),
    ).resolves.toBe(11);
    expect(calls).toBe(2);
  });

  it("uses the local managed RootFS cache without calling the hub", async () => {
    const image = `cocalc.local/rootfs/${"b".repeat(64)}`;
    const cachePath = imageCachePath(image);
    const metadataPath = preflightMetadataFilePath(image);
    await mkdir(join(cachePath, "usr"), { recursive: true });
    await writeFile(
      metadataPath,
      JSON.stringify(
        {
          version: ROOTFS_NORMALIZER_VERSION,
          normalized_at: new Date().toISOString(),
          image,
          rootfs_path: cachePath,
          distro_family: "debian",
          package_manager: "apt-get",
          shell: "/bin/bash",
          glibc: true,
          sudo_present: true,
          ca_certificates_present: true,
          size_bytes: 123,
        },
        null,
        2,
      ),
    );

    const getManagedRootfsReleaseArtifact = jest.mocked(
      hubApi.hosts.getManagedRootfsReleaseArtifact,
    );
    getManagedRootfsReleaseArtifact.mockRejectedValue(
      new Error("hub should not be called for a valid local cache"),
    );

    const entry = await pullRootfsCacheEntry(image, {
      awaitRegionalReplication: false,
    });

    expect(getManagedRootfsReleaseArtifact).not.toHaveBeenCalled();
    expect(entry.image).toBe(image);
    expect(entry.cache_path).toBe(cachePath);
    expect(entry.size_bytes).toBe(123);
    expect(entry.project_count).toBe(0);
    expect(entry.running_project_count).toBe(0);
  });
});
