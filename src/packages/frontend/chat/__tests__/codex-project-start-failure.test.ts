import { message, Modal } from "antd";
import { showCodexProjectStartFailure } from "../codex-project-start-failure";
import { showRuntimeSponsorDenialModal } from "@cocalc/frontend/project/start-button";
import { encodeRuntimeSponsorDenial } from "@cocalc/util/runtime-sponsor-denial";
import { ProjectStartPolicyBlockError } from "@cocalc/frontend/projects/runtime-start-policy";
import { showProjectStartRequiredModal } from "@cocalc/frontend/projects/start-required-modal";

jest.mock("@cocalc/frontend/project/start-button", () => ({
  showRuntimeSponsorDenialModal: jest.fn(),
}));
jest.mock("@cocalc/frontend/projects/start-required-modal", () => ({
  showProjectStartRequiredModal: jest.fn(),
}));
jest.spyOn(Modal, "error").mockImplementation(jest.fn() as any);
jest.spyOn(message, "success").mockImplementation(jest.fn() as any);
beforeEach(() => jest.clearAllMocks());

test("Codex sponsored-slot denial opens the project choice dialog, not a raw error", () => {
  const denial = {
    code: "runtime_sponsor_slots_exhausted" as const,
    sponsor_account_id: "sponsor-1",
    limit: 2,
    current: 3,
    active_projects: [],
  };
  showCodexProjectStartFailure({
    error: new Error(encodeRuntimeSponsorDenial(denial)),
    projectId: "project-1",
    onOpenMembershipDetails: jest.fn(),
  });

  expect(showRuntimeSponsorDenialModal).toHaveBeenCalledWith(
    expect.objectContaining({
      denial,
      project_id: "project-1",
      onOpenMembershipDetails: expect.any(Function),
      onStarted: expect.any(Function),
    }),
  );
  expect(Modal.error).not.toHaveBeenCalled();
  const { onStarted } = (showRuntimeSponsorDenialModal as jest.Mock).mock
    .calls[0][0];
  onStarted();
  expect(message.success).toHaveBeenCalledWith(
    expect.stringContaining("Your draft is still in the composer"),
  );
});

test("other project-start policy blocks keep their existing start prompt", () => {
  const block = {
    code: "autostart_disabled" as const,
    message: "Automatic start is disabled",
  };
  showCodexProjectStartFailure({
    error: new ProjectStartPolicyBlockError(block),
    projectId: "project-1",
    onOpenMembershipDetails: jest.fn(),
  });
  expect(showProjectStartRequiredModal).toHaveBeenCalledWith({
    project_id: "project-1",
    title: "Start project to use Codex",
    block,
  });
  expect(Modal.error).not.toHaveBeenCalled();
});
