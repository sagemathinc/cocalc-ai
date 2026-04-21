jest.mock("./software", () => ({
  getSoftwareVersions: jest.fn(() => ({})),
}));

import { getSoftwareVersions } from "./software";
import { __test__ } from "./managed-components";

const getSoftwareVersionsMock = getSoftwareVersions as jest.MockedFunction<
  typeof getSoftwareVersions
>;

describe("managed component status model", () => {
  beforeEach(() => {
    getSoftwareVersionsMock.mockReturnValue({});
  });

  it("marks disabled components as disabled with unknown version state", () => {
    expect(
      __test__.summarizeManagedComponentStatus({
        component: "conat-router",
        artifact: "project-host",
        upgrade_policy: "restart_now",
        enabled: false,
        managed: false,
        desired_version: "v1",
        running_versions: [],
        running_pids: [],
      }),
    ).toMatchObject({
      runtime_state: "disabled",
      version_state: "unknown",
    });
  });

  it("marks managed components with no pid as stopped", () => {
    expect(
      __test__.summarizeManagedComponentStatus({
        component: "conat-persist",
        artifact: "project-host",
        upgrade_policy: "restart_now",
        enabled: true,
        managed: true,
        desired_version: "v1",
        running_versions: [],
        running_pids: [],
      }),
    ).toMatchObject({
      runtime_state: "stopped",
      version_state: "unknown",
    });
  });

  it("marks single-version running components as aligned", () => {
    expect(
      __test__.summarizeManagedComponentStatus({
        component: "project-host",
        artifact: "project-host",
        upgrade_policy: "restart_now",
        enabled: true,
        managed: true,
        desired_version: "v1",
        running_versions: ["v1"],
        running_pids: [1234],
      }),
    ).toMatchObject({
      runtime_state: "running",
      version_state: "aligned",
    });
  });

  it("marks mixed versions explicitly", () => {
    expect(
      __test__.summarizeManagedComponentStatus({
        component: "acp-worker",
        artifact: "project-host",
        upgrade_policy: "drain_then_replace",
        enabled: true,
        managed: true,
        desired_version: "v2",
        running_versions: ["v1", "v2"],
        running_pids: [111, 222],
      }),
    ).toMatchObject({
      runtime_state: "running",
      version_state: "mixed",
    });
  });

  it("normalizes the current numeric project-host bundle version to its build id", () => {
    getSoftwareVersionsMock.mockReturnValue({
      project_host: "1776808579069",
      project_host_build_id: "20260421T215608Z-39cf7e213a49",
    });

    expect(__test__.normalizeProjectHostRuntimeVersion("1776808579069")).toBe(
      "20260421T215608Z-39cf7e213a49",
    );
    expect(__test__.normalizeProjectHostRuntimeVersion("1776577465070")).toBe(
      "1776577465070",
    );
  });
});
