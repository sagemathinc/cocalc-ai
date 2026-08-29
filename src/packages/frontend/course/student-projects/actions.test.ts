/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

let ensureCourseManagerAccessMock: jest.Mock;
let listInvitesMock: jest.Mock;
let removeCollaboratorMock: jest.Mock;
let respondInviteMock: jest.Mock;

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => ({
      remove_collaborator: (...args: any[]) => removeCollaboratorMock(...args),
    }),
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    project_collaborators: {
      ensure_course_manager_access: (...args: any[]) =>
        ensureCourseManagerAccessMock(...args),
      list_invites: (...args: any[]) => listInvitesMock(...args),
      respond_invite: (...args: any[]) => respondInviteMock(...args),
    },
  },
}));

import { Map as iMap } from "immutable";

import { StudentProjectsActions } from "./actions";

describe("StudentProjectsActions.removeFromAllStudentProjects", () => {
  beforeEach(() => {
    ensureCourseManagerAccessMock = jest.fn(async ({ project_ids }) =>
      project_ids.map((project_id) => ({ project_id })),
    );
    listInvitesMock = jest.fn(async () => []);
    removeCollaboratorMock = jest.fn(async () => undefined);
    respondInviteMock = jest.fn(async () => undefined);
  });

  function createActions() {
    const store = {
      get_shared_project_id: () => "shared-project",
      get: (key: string) => {
        if (key === "course_project_id") return "course-project";
        if (key === "course_filename") return "class.course";
        return undefined;
      },
    };
    const courseActions = {
      get_store: () => store,
      set_error: jest.fn(),
    };
    return new StudentProjectsActions(courseActions as any);
  }

  it("revokes a pending course invite before removing project access", async () => {
    listInvitesMock.mockResolvedValue([
      {
        context: {
          student_id: "student-1",
          student_project_id: "student-project",
        },
        invite_id: "invite-1",
        invite_source: "course_email",
        scope: "course_student",
        status: "pending",
        target_email: "student@example.com",
      },
      {
        context: {
          student_id: "student-1",
          student_project_id: "student-project",
        },
        invite_id: "invite-2",
        invite_source: "course_email",
        scope: "course_student",
        status: "pending",
        target_email: "old-address@example.com",
      },
      {
        context: {
          student_id: "student-2",
          student_project_id: "other-project",
        },
        invite_id: "unrelated-invite",
        invite_source: "course_email",
        scope: "course_student",
        status: "pending",
        target_email: "other@example.com",
      },
    ]);
    const student = iMap({
      account_id: "student-account",
      email_address: "student@example.com",
      project_id: "student-project",
      student_id: "student-1",
    });
    const actions = createActions();

    await actions.removeFromAllStudentProjects(student as any);

    expect(ensureCourseManagerAccessMock).toHaveBeenCalledWith({
      course_path: "class.course",
      course_project_id: "course-project",
      project_ids: ["student-project"],
    });
    expect(listInvitesMock).toHaveBeenCalledWith({
      direction: "outbound",
      limit: 1000,
      projectWide: true,
      project_id: "student-project",
      status: "pending",
    });
    expect(respondInviteMock).toHaveBeenCalledTimes(2);
    expect(respondInviteMock).toHaveBeenCalledWith({
      action: "revoke",
      invite_id: "invite-1",
      project_id: "student-project",
    });
    expect(respondInviteMock).toHaveBeenCalledWith({
      action: "revoke",
      invite_id: "invite-2",
      project_id: "student-project",
    });
    expect(removeCollaboratorMock).toHaveBeenCalledTimes(2);
    expect(removeCollaboratorMock).toHaveBeenCalledWith(
      "student-project",
      "student-account",
    );
    expect(removeCollaboratorMock).toHaveBeenCalledWith(
      "shared-project",
      "student-account",
    );
  });

  it("does not require an invite when removing an existing collaborator", async () => {
    const student = iMap({
      account_id: "student-account",
      project_id: "student-project",
      student_id: "student-1",
    });
    const actions = createActions();

    await actions.removeFromAllStudentProjects(student as any);

    expect(respondInviteMock).not.toHaveBeenCalled();
    expect(removeCollaboratorMock).toHaveBeenCalledTimes(2);
  });
});
