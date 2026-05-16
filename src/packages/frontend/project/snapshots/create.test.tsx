/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CreateSnapshot from "./create";

const createSnapshot = jest.fn(async (_opts?: any) => undefined);
const getSnapshotQuota = jest.fn(async () => ({
  limit: 8,
  manual: { limit: 6, current: 1, rolling_reserved: 2 },
}));
const setState = jest.fn();
const originalGetComputedStyle = window.getComputedStyle;

jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({
    project_id: "project-1",
    actions: {
      setState,
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
          createSnapshot: (opts: any) => createSnapshot(opts),
          getSnapshotQuota: (opts: any) => getSnapshotQuota(opts),
        },
      },
    },
  },
}));

describe("CreateSnapshot", () => {
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
    createSnapshot.mockClear();
    getSnapshotQuota.mockClear();
    setState.mockClear();
  });

  it("calls onCreated after a successful snapshot create", async () => {
    const onCreated = jest.fn();
    render(<CreateSnapshot onCreated={onCreated} />);

    fireEvent.click(
      screen.getAllByRole("button", { name: /Create Snapshot/i })[0],
    );

    const input = await screen.findByPlaceholderText(
      "Name of snapshot to create...",
    );
    await waitFor(() =>
      expect(getSnapshotQuota).toHaveBeenCalledWith({
        project_id: "project-1",
      }),
    );
    expect(
      screen.getByText(/can keep up to/i, { selector: "p" }),
    ).toHaveTextContent("8 snapshots in total");
    expect(
      screen.getByText(/can keep up to/i, { selector: "p" }),
    ).toHaveTextContent("leaving 6 named snapshot slots");
    fireEvent.change(input, { target: { value: "snapshot-1" } });
    fireEvent.click(
      screen.getAllByRole("button", { name: /Create Snapshot/i }).slice(-1)[0],
    );

    await waitFor(() =>
      expect(createSnapshot).toHaveBeenCalledWith({
        project_id: "project-1",
        name: "snapshot-1",
      }),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });
});
