/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Map } from "immutable";
import { applyExamSessionBootstrap } from "./exam-bootstrap";
import { webapp_client as mockWebappClient } from "@cocalc/frontend/webapp-client";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {},
}));

describe("applyExamSessionBootstrap", () => {
  beforeEach(() => {
    mockWebappClient.account_id = "normal-site-account";
  });

  it("hydrates the temporary account and project stores", () => {
    const accountSetState = jest.fn();
    const projectSetState = jest.fn();
    const emit = jest.fn();
    const redux = {
      getStore: (name: string) => {
        if (name === "account") {
          return {
            get: (key: string) => {
              if (key === "is_ready") return false;
              if (key === "editor_settings") {
                return Map({ smart_indent: true, tab_size: 4 });
              }
              if (key === "other_settings") {
                return Map({ dark_mode: false, katex: true });
              }
              return undefined;
            },
            emit,
          };
        }
        return { get: () => undefined };
      },
      getActions: (name: string) => ({
        setState: name === "account" ? accountSetState : projectSetState,
      }),
    };

    applyExamSessionBootstrap({
      redux,
      session: {
        account: { account_id: "account-1", display_name: "Exam User" },
        project: { project_id: "project-1", title: "Exam Scratchpad" },
      },
    });

    expect(accountSetState).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        account_id: "account-1",
        editor_settings: expect.objectContaining({
          smart_indent: true,
          tab_size: 4,
        }),
        other_settings: expect.objectContaining({
          dark_mode: false,
          katex: true,
        }),
        is_logged_in: true,
        user_type: "signed_in",
      }),
    );
    expect(accountSetState).toHaveBeenNthCalledWith(2, { is_ready: true });
    expect(emit).toHaveBeenCalledWith("is_ready");
    expect(mockWebappClient.account_id).toBe("account-1");
    const projectMap = projectSetState.mock.calls[0][0].project_map;
    expect(projectMap.getIn(["project-1", "title"])).toBe("Exam Scratchpad");
  });

  it("keeps the exam project's course restrictions for the student UI", () => {
    const projectSetState = jest.fn();
    const redux = {
      getStore: (name: string) =>
        name === "account"
          ? { get: () => undefined, emit: jest.fn() }
          : { get: () => undefined },
      getActions: (name: string) => ({
        setState: name === "account" ? jest.fn() : projectSetState,
      }),
    };
    applyExamSessionBootstrap({
      redux,
      session: {
        account: { account_id: "account-1", display_name: "Exam User" },
        project: {
          project_id: "project-1",
          title: "Exam Scratchpad",
          course: {
            student_project_functionality: {
              disableTerminals: true,
              disableUploads: true,
            },
          },
        },
      },
    });
    const projectMap = projectSetState.mock.calls[0][0].project_map;
    const path = ["project-1", "course", "student_project_functionality"];
    expect(projectMap.getIn([...path, "disableUploads"])).toBe(true);
    expect(projectMap.getIn([...path, "disableTerminals"])).toBe(true);
  });

  it("does nothing without an authenticated exam session", () => {
    const redux = { getStore: jest.fn(), getActions: jest.fn() };
    applyExamSessionBootstrap({ redux });
    expect(redux.getStore).not.toHaveBeenCalled();
    expect(mockWebappClient.account_id).toBe("normal-site-account");
  });
});
