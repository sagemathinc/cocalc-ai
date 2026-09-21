/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "react-intl";

import { DeleteAllStudentProjects } from "./delete-all-student-projects";

const mockRunFreshAuthAction = jest.fn(
  async (action: () => Promise<void>): Promise<boolean> => {
    await action();
    return true;
  },
);

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => <div data-testid="fresh-auth-modal" />,
  useFreshAuthAction: () => ({
    runFreshAuthAction: mockRunFreshAuthAction,
    freshAuthModalProps: {},
  }),
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: { name: string }) => <span>{name}</span>,
  Paragraph: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));

jest.mock("antd", () => ({
  Button: ({ children }: { children: ReactNode }) => (
    <button>{children}</button>
  ),
  Card: ({ children, title }: any) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  Popconfirm: ({ children, onConfirm }: any) => (
    <div>
      {children}
      <button onClick={onConfirm}>Confirm deletion</button>
    </div>
  ),
}));

describe("DeleteAllStudentProjects", () => {
  beforeEach(() => {
    mockRunFreshAuthAction.mockClear();
  });

  it("runs bulk deletion through fresh authentication", async () => {
    const deleteAllStudentProjects = jest.fn(async () => undefined);

    render(
      <IntlProvider locale="en">
        <DeleteAllStudentProjects
          actions={{
            student_projects: { deleteAllStudentProjects },
          }}
        />
      </IntlProvider>,
    );

    expect(screen.getByTestId("fresh-auth-modal")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm deletion" }));

    await waitFor(() =>
      expect(mockRunFreshAuthAction).toHaveBeenCalledTimes(1),
    );
    expect(deleteAllStudentProjects).toHaveBeenCalledTimes(1);
  });
});
