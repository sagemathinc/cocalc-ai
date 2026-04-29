import {
  applyProjectHostProcessTitle,
  getProjectHostProcessRole,
  getProjectHostProcessTitle,
} from "./process-role";

describe("project-host process role helpers", () => {
  it("detects long-lived runtime roles from env and args", () => {
    expect(
      getProjectHostProcessRole({
        env: { COCALC_PROJECT_HOST_AGENT: "1" },
      }),
    ).toBe("host-agent");
    expect(
      getProjectHostProcessRole({
        env: { COCALC_PROJECT_HOST_CONAT_ROUTER_DAEMON: "1" },
      }),
    ).toBe("conat-router");
    expect(
      getProjectHostProcessRole({
        env: { COCALC_PROJECT_HOST_CONAT_PERSIST_DAEMON: "1" },
      }),
    ).toBe("conat-persist");
    expect(
      getProjectHostProcessRole({
        env: { COCALC_PROJECT_HOST_ACP_WORKER: "1" },
      }),
    ).toBe("acp-worker");
    expect(
      getProjectHostProcessRole({
        env: { COCALC_CONAT_CLUSTER_NODE: "1" },
      }),
    ).toBe("conat-router-cluster-node");
    expect(
      getProjectHostProcessRole({
        args: ["privileged-rm-helper", "/tmp/path"],
      }),
    ).toBe("privileged-rm-helper");
    expect(getProjectHostProcessRole({ env: {} })).toBe("app");
  });

  it("formats stable process titles for ps output", () => {
    expect(
      getProjectHostProcessTitle({
        env: {
          COCALC_PROJECT_HOST_AGENT: "1",
          COCALC_PROJECT_HOST_AGENT_INDEX: "2",
        },
      }),
    ).toBe("project-host:host-agent:2");
    expect(
      getProjectHostProcessTitle({
        env: { COCALC_PROJECT_HOST_CONAT_ROUTER_DAEMON: "1" },
      }),
    ).toBe("project-host:conat-router");
    expect(
      getProjectHostProcessTitle({
        env: { COCALC_PROJECT_HOST_CONAT_PERSIST_DAEMON: "1" },
      }),
    ).toBe("project-host:conat-persist");
    expect(
      getProjectHostProcessTitle({
        env: { COCALC_PROJECT_HOST_ACP_WORKER: "1" },
      }),
    ).toBe("project-host:acp-worker");
    expect(
      getProjectHostProcessTitle({
        args: ["privileged-rm-helper", "/tmp/path"],
      }),
    ).toBe("project-host:privileged-rm-helper");
    expect(getProjectHostProcessTitle({ env: {} })).toBe("project-host:app");
  });

  it("applies the derived process title", () => {
    const processRef = { title: "node" } as NodeJS.Process;
    const title = applyProjectHostProcessTitle({
      env: { COCALC_PROJECT_HOST_CONAT_PERSIST_DAEMON: "1" },
      processRef,
    });
    expect(title).toBe("project-host:conat-persist");
    expect(processRef.title).toBe("project-host:conat-persist");
  });
});
