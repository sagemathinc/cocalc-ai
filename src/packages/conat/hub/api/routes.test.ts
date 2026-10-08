/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getHubApiPrincipalPolicy } from "./index";
import {
  getHubApiRoute,
  getHubApiRoutedMethods,
  hubApiRouteKey,
} from "./routes";

const PROJECT = "6b0f0b1e-2a1f-4b7e-8d7c-0c2f8a9b1c3d";

describe("hub API routes", () => {
  it("routes only real methods that accounts can call", () => {
    for (const name of getHubApiRoutedMethods()) {
      expect([name, getHubApiPrincipalPolicy(name)]).toEqual([name, "account"]);
    }
  });

  it("finds each routed method's owning project", () => {
    expect(
      hubApiRouteKey(getHubApiRoute("projects.setProjectMetadata")!, [
        { project_id: PROJECT },
      ]),
    ).toBe(PROJECT);
    expect(
      hubApiRouteKey(getHubApiRoute("projects.setProjectUserRole")!, [
        { opts: { project_id: PROJECT } },
      ]),
    ).toBe(PROJECT);
  });

  it("treats malformed keys as unroutable", () => {
    const route = getHubApiRoute("projects.setProjectMetadata")!;
    expect(hubApiRouteKey(route, [{ project_id: "x" }])).toBeUndefined();
    expect(hubApiRouteKey(route, [])).toBeUndefined();
  });

  it("finds an email invite by id or link token", () => {
    const route = getHubApiRoute("projects.redeemEmailProjectInvite")!;
    expect(route.owner).toBe("collab-invite");
    expect(hubApiRouteKey(route, [{ invite_id: PROJECT, token: "t" }])).toEqual(
      { invite_id: PROJECT, token: "t" },
    );
    expect(hubApiRouteKey(route, [{ token: "t" }])).toEqual({ token: "t" });
    // Neither a valid id nor a bounded token: unroutable.
    expect(hubApiRouteKey(route, [{ invite_id: "x" }])).toBeUndefined();
    expect(hubApiRouteKey(route, [{ token: "t".repeat(513) }])).toBeUndefined();
    expect(hubApiRouteKey(route, [{ token: 7 }])).toBeUndefined();
  });

  it("does not route other methods or prototype names", () => {
    expect(getHubApiRoute("projects.createProject")).toBeUndefined();
    expect(getHubApiRoute("toString")).toBeUndefined();
    expect(getHubApiRoute("constructor")).toBeUndefined();
  });
});
