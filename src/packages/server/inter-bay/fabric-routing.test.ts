/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

import getPort from "@cocalc/backend/get-port";
import { connect, type Client } from "@cocalc/conat/core/client";
import {
  init as createConatServer,
  type ConatServer,
} from "@cocalc/conat/core/server";
import { once } from "@cocalc/util/async-utils";

describe("inter-bay fabric routing", () => {
  let fabric: ConatServer | undefined;
  let serviceClient: Client | undefined;
  const env = {
    bay_id: process.env.COCALC_BAY_ID,
    server: process.env.COCALC_INTER_BAY_CONAT_SERVER,
    password: process.env.COCALC_INTER_BAY_CONAT_PASSWORD,
  };

  beforeEach(() => {
    jest.resetModules();
    delete process.env.COCALC_BAY_ID;
    delete process.env.COCALC_INTER_BAY_CONAT_SERVER;
    delete process.env.COCALC_INTER_BAY_CONAT_PASSWORD;
  });

  afterEach(async () => {
    serviceClient?.close();
    serviceClient = undefined;
    if (fabric) {
      await fabric.close();
      fabric = undefined;
    }
  });

  afterAll(() => {
    process.env.COCALC_BAY_ID = env.bay_id;
    process.env.COCALC_INTER_BAY_CONAT_SERVER = env.server;
    process.env.COCALC_INTER_BAY_CONAT_PASSWORD = env.password;
  });

  it("routes directory and project-control requests over a separate fabric address", async () => {
    const port = await getPort();
    fabric = createConatServer({
      port,
      path: "/conat",
      getUser: async () => ({ hub_id: "hub" }),
      isAllowed: async () => true,
    });
    if (fabric.state !== "ready") {
      await once(fabric, "ready");
    }
    process.env.COCALC_INTER_BAY_CONAT_SERVER = fabric.address();
    process.env.COCALC_INTER_BAY_CONAT_PASSWORD = "dev-fabric";

    serviceClient = connect({
      address: fabric.address(),
      noCache: true,
    });
    await serviceClient.waitUntilSignedIn();

    const projectControlSub = await serviceClient.subscribe(
      "bay.bay-1.rpc.project-control.start",
      { queue: "0" },
    );
    const projectStartPromise = (async () => {
      for await (const mesg of projectControlSub) {
        mesg.respond({ handled_by: "bay-1" }, { noThrow: true });
        return mesg.data;
      }
    })();
    const projectControlStopSub = await serviceClient.subscribe(
      "bay.bay-1.rpc.project-control.stop",
      { queue: "0" },
    );
    const projectStopPromise = (async () => {
      for await (const mesg of projectControlStopSub) {
        mesg.respond(null, { noThrow: true });
        return mesg.data;
      }
    })();

    const directorySub = await serviceClient.subscribe(
      "global.directory.rpc.resolve-project-bay",
      { queue: "0" },
    );
    const directoryPromise = (async () => {
      for await (const mesg of directorySub) {
        mesg.respond({ bay_id: "bay-1", epoch: 3 }, { noThrow: true });
        return mesg.data;
      }
    })();

    process.env.COCALC_BAY_ID = "bay-0";
    const [
      { resolveProjectBay },
      { getInterBayBridge },
      { getInterBayFabricClient },
    ] = await Promise.all([
      import("./directory"),
      import("./bridge"),
      import("./fabric"),
    ]);

    await expect(resolveProjectBay("proj-1")).resolves.toEqual({
      bay_id: "bay-1",
      epoch: 3,
    });
    await getInterBayBridge()
      .projectControl("bay-1")
      .start({ project_id: "proj-1", account_id: "acct-1" });
    await getInterBayBridge()
      .projectControl("bay-1")
      .stop({ project_id: "proj-1" });

    await expect(directoryPromise).resolves.toEqual({
      name: "resolveProjectBay",
      args: [{ project_id: "proj-1" }],
    });
    await expect(projectStartPromise).resolves.toEqual({
      name: "start",
      args: [{ project_id: "proj-1", account_id: "acct-1" }],
    });
    await expect(projectStopPromise).resolves.toEqual({
      name: "stop",
      args: [{ project_id: "proj-1" }],
    });
    getInterBayFabricClient().close();
    projectControlSub.close();
    projectControlStopSub.close();
    directorySub.close();
  });
});
