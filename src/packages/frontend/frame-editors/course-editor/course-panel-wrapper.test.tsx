/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";
import { Map } from "immutable";
import {
  redux,
  useEditorRedux,
  useRedux,
} from "@cocalc/frontend/app-framework";
import { wrap } from "./course-panel-wrapper";
import type { FrameProps, PanelProps } from "./course-panel-wrapper";

jest.mock("@cocalc/frontend/app-framework", () => ({
  React: jest.requireActual("react"),
  redux: { getActions: jest.fn(), getStore: jest.fn() },
  useEditorRedux: jest.fn(),
  useRedux: jest.fn(),
  useTypedRedux: () => Map(),
}));
jest.mock("@cocalc/frontend/components", () => ({
  ActivityDisplay: () => null,
  Loading: () => <div role="status">Loading course</div>,
}));
jest.mock("@cocalc/frontend/components/error", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@cocalc/frontend/course/modals", () => ({
  __esModule: true,
  default: ({ modal, path, actions }) =>
    modal && actions ? (
      <div role="dialog" aria-label={modal} data-path={path} />
    ) : null,
}));
jest.mock("@cocalc/frontend/course/pay-banner", () => ({
  PayBanner: () => null,
}));
jest.mock("@cocalc/frontend/frame-editors/frame-tree/hooks", () => ({
  getScale: () => 1,
}));
jest.mock("./course-actions", () => ({
  course_redux_name: (projectId, path) => `course-editor-${projectId}-${path}`,
}));
jest.mock("./course-tab-bar", () => ({
  CourseTabBar: () => null,
}));

const projectId = "8867ce1b-b246-4510-acba-0a39cd96e9c9";
const canonicalPath = "/home/user/funding.course";
const courseName = `course-editor-${projectId}-${canonicalPath}`;

it.each(["/funding.course", canonicalPath])(
  "reads ready course state and modals using editor identity for tab %s",
  (displayPath) => {
    const courseActions = {};
    const fields = {
      students: Map(),
      assignments: Map(),
      handouts: Map(),
      settings: Map({ title: "Funding QA" }),
    };
    (useRedux as jest.Mock).mockImplementation((name, field) =>
      name === courseName ? fields[field] : undefined,
    );
    (useEditorRedux as jest.Mock).mockImplementation(
      ({ path }) =>
        () =>
          path === canonicalPath ? "add-students" : undefined,
    );
    (redux.getActions as jest.Mock).mockImplementation((name) =>
      name === courseName ? courseActions : undefined,
    );
    (redux.getStore as jest.Mock).mockImplementation((name) =>
      name === courseName
        ? {
            num_students: () => 0,
            num_assignments: () => 0,
            num_handouts: () => 0,
          }
        : undefined,
    );
    const panel = jest.fn((props: PanelProps) => (
      <h2>{props.settings.get("title")}</h2>
    ));
    const Wrapped = wrap(panel);
    const props = {
      id: "students",
      project_id: projectId,
      path: displayPath,
      font_size: 14,
      actions: { path: canonicalPath, course_actions: courseActions },
      desc: Map({ type: "course_students" }),
    } as unknown as FrameProps;

    render(<Wrapped {...props} />);

    expect(screen.getByRole("heading", { name: "Funding QA" })).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen.getByRole("dialog", { name: "add-students" }),
    ).toHaveAttribute("data-path", canonicalPath);
    expect(panel.mock.calls[0][0]).toMatchObject({
      path: canonicalPath,
      name: courseName,
      actions: courseActions,
    });
  },
);
