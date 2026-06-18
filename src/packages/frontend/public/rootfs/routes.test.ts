/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getPublicRouteFromPath, isPublicTarget } from "../routes";
import {
  getRootfsRouteFromPath,
  rootfsEntryMatchesImageTarget,
  rootfsPath,
} from "./routes";

describe("public rootfs routes", () => {
  it("parses slug routes", () => {
    expect(getRootfsRouteFromPath("/rootfs/minimal-jupyter")).toEqual({
      slug: "minimal-jupyter",
      view: "slug",
    });
    expect(getPublicRouteFromPath("/rootfs/minimal-jupyter")).toEqual({
      route: { slug: "minimal-jupyter", view: "slug" },
      section: "rootfs",
    });
  });

  it("parses image id routes", () => {
    expect(getRootfsRouteFromPath("/rootfs/id/sha256%3Aabc")).toEqual({
      imageId: "sha256:abc",
      view: "image-id",
    });
  });

  it("allows public rootfs targets", () => {
    expect(isPublicTarget("/rootfs/minimal-jupyter")).toBe(true);
    expect(isPublicTarget("/rootfs/id/rootfs-image-1")).toBe(true);
  });

  it("prefers slug links over image id links", () => {
    expect(rootfsPath({ id: "rootfs-image-1", slug: "minimal-jupyter" })).toBe(
      "/rootfs/minimal-jupyter",
    );
    expect(rootfsPath({ id: "rootfs-image-1" })).toBe(
      "/rootfs/id/rootfs-image-1",
    );
  });

  it("matches image targets by catalog id, digest, or image suffix", () => {
    const entry = {
      digest: "sha256:abc",
      id: "catalog-id",
      image: "cocalc.local/rootfs/e50647",
      release_id: "release-id",
    };
    expect(rootfsEntryMatchesImageTarget(entry, "catalog-id")).toBe(true);
    expect(rootfsEntryMatchesImageTarget(entry, "release-id")).toBe(true);
    expect(rootfsEntryMatchesImageTarget(entry, "sha256:abc")).toBe(true);
    expect(rootfsEntryMatchesImageTarget(entry, "e50647")).toBe(true);
    expect(
      rootfsEntryMatchesImageTarget(entry, "cocalc.local/rootfs/e50647"),
    ).toBe(true);
    expect(rootfsEntryMatchesImageTarget(entry, "missing")).toBe(false);
  });
});
