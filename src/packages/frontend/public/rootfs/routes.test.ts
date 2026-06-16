/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getPublicRouteFromPath, isPublicTarget } from "../routes";
import { getRootfsRouteFromPath, rootfsPath } from "./routes";

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
});
