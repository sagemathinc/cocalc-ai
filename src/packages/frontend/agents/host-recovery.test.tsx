import { render, screen } from "@testing-library/react";
import { AgentHostRecovery } from "./host-recovery";

const ensureHostInfo = jest.fn().mockResolvedValue(undefined);
let projectState = "starting";
let hostStatus = "starting";

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ ensure_host_info: ensureHostInfo }) },
  useProjectFromMap: () => ({
    get: () => "host-1",
    getIn: () => projectState,
  }),
}));
jest.mock("@cocalc/frontend/projects/host-info", () => ({
  useHostInfo: () => ({
    get: (key: string) =>
      ({
        status: hostStatus,
        online: hostStatus === "running",
        recovery_phase: "restarting",
        desired_state: "running",
        desired_pricing_model: "spot",
      })[key],
  }),
}));
jest.mock("@cocalc/frontend/project/page/host-recovery-banner", () => ({
  HostRecoveryBanner: ({ recovery }) => (
    <div role="status">{recovery.title}</div>
  ),
}));

test("explains Spot recovery while an agent project is starting", () => {
  projectState = "starting";
  hostStatus = "starting";
  render(<AgentHostRecovery projectId="project-1" />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Project host is restarting automatically",
  );
  expect(ensureHostInfo).toHaveBeenCalledWith("host-1", true);
});

test("removes the recovery notice once project and host are operational", () => {
  projectState = "running";
  hostStatus = "running";
  render(<AgentHostRecovery projectId="project-1" />);
  expect(screen.queryByRole("status")).toBeNull();
});
