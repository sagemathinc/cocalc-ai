/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CreateBackup from "./create";

const createBackup = jest.fn(async (_opts?: any) => ({ op_id: "backup-op-1" }));
const setState = jest.fn();
const trackBackupOp = jest.fn();
const originalGetComputedStyle = window.getComputedStyle;

jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({
    project_id: "project-1",
    actions: {
      setState,
      trackBackupOp,
    },
  }),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => false,
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        projects: {
          createBackup: (opts: any) => createBackup(opts),
        },
      },
    },
  },
}));

describe("CreateBackup", () => {
  beforeAll(() => {
    Object.defineProperty(window, "getComputedStyle", {
      configurable: true,
      value: jest.fn(() => ({
        getPropertyValue: () => "",
      })),
    });
  });

  afterAll(() => {
    Object.defineProperty(window, "getComputedStyle", {
      configurable: true,
      value: originalGetComputedStyle,
    });
  });

  beforeEach(() => {
    createBackup.mockClear();
    setState.mockClear();
    trackBackupOp.mockClear();
  });

  it("calls onCreated after a successful backup create", async () => {
    const onCreated = jest.fn();
    render(<CreateBackup onCreated={onCreated} />);

    fireEvent.click(
      screen.getAllByRole("button", { name: /Create Backup/i })[0],
    );
    fireEvent.click(
      await screen
        .findAllByRole("button", { name: /Create Backup/i })
        .then((buttons) => buttons.slice(-1)[0]),
    );

    await waitFor(() =>
      expect(createBackup).toHaveBeenCalledWith({
        project_id: "project-1",
      }),
    );
    expect(trackBackupOp).toHaveBeenCalledWith({ op_id: "backup-op-1" });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });
});
