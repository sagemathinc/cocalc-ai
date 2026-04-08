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
    const projectControlRestartSub = await serviceClient.subscribe(
      "bay.bay-1.rpc.project-control.restart",
      { queue: "0" },
    );
    const projectRestartPromise = (async () => {
      for await (const mesg of projectControlRestartSub) {
        mesg.respond(null, { noThrow: true });
        return mesg.data;
      }
    })();
    const projectControlStateSub = await serviceClient.subscribe(
      "bay.bay-1.rpc.project-control.state",
      { queue: "0" },
    );
    const projectStatePromise = (async () => {
      for await (const mesg of projectControlStateSub) {
        mesg.respond({ state: "running", ip: "10.1.2.3" }, { noThrow: true });
        return mesg.data;
      }
    })();
    const projectControlAddressSub = await serviceClient.subscribe(
      "bay.bay-1.rpc.project-control.address",
      { queue: "0" },
    );
    const projectAddressPromise = (async () => {
      for await (const mesg of projectControlAddressSub) {
        mesg.respond(
          {
            host: "10.1.2.3",
            port: 4242,
            secret_token: "secret",
          },
          { noThrow: true },
        );
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
    const projectLroSub = await serviceClient.subscribe(
      "bay.bay-1.rpc.project-lro.publish-progress",
      { queue: "0" },
    );
    const projectLroPromise = (async () => {
      for await (const mesg of projectLroSub) {
        mesg.respond(null, { noThrow: true });
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
    await getInterBayBridge()
      .projectControl("bay-1")
      .restart({ project_id: "proj-1", account_id: "acct-1" });
    await expect(
      getInterBayBridge().projectControl("bay-1").state({
        project_id: "proj-1",
      }),
    ).resolves.toEqual({ state: "running", ip: "10.1.2.3" });
    await expect(
      getInterBayBridge().projectControl("bay-1").address({
        project_id: "proj-1",
        account_id: "acct-1",
      }),
    ).resolves.toEqual({
      host: "10.1.2.3",
      port: 4242,
      secret_token: "secret",
    });
    await getInterBayBridge()
      .projectLro("bay-1")
      .publishProgress({
        project_id: "proj-1",
        op_id: "op-1",
        event: {
          type: "progress",
          ts: 1,
          phase: "runner_start",
          message: "starting",
          progress: 86,
        },
      });

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
    await expect(projectRestartPromise).resolves.toEqual({
      name: "restart",
      args: [{ project_id: "proj-1", account_id: "acct-1" }],
    });
    await expect(projectStatePromise).resolves.toEqual({
      name: "state",
      args: [{ project_id: "proj-1" }],
    });
    await expect(projectAddressPromise).resolves.toEqual({
      name: "address",
      args: [{ project_id: "proj-1", account_id: "acct-1" }],
    });
    await expect(projectLroPromise).resolves.toEqual({
      name: "publishProgress",
      args: [
        {
          project_id: "proj-1",
          op_id: "op-1",
          event: {
            type: "progress",
            ts: 1,
            phase: "runner_start",
            message: "starting",
            progress: 86,
          },
        },
      ],
    });
    getInterBayFabricClient().close();
    projectControlSub.close();
    projectControlStopSub.close();
    projectControlRestartSub.close();
    projectControlStateSub.close();
    projectControlAddressSub.close();
    projectLroSub.close();
    directorySub.close();
  });
});
