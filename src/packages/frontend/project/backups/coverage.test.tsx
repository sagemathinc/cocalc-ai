/** @jest-environment jsdom */
import { TextDecoder } from "node:util";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { getBackupCoverage } from "../archive-info";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import BackupCoverage from "./coverage";

jest.mock("../archive-info", () => ({
  getBackupCoverage: jest.fn(),
  getBackupCoverageReportChunk: jest.fn(),
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: { projects: { backupWarningAcknowledgements: jest.fn() } },
    },
  },
}));
const get = jest.mocked(getBackupCoverage);
const ack = jest.mocked(
  webapp_client.conat_client.hub.projects.backupWarningAcknowledgements,
);
const key = "c".repeat(64);
const backup_id = "a".repeat(64);
function page(project_id = "project-a") {
  return {
    project_id,
    backup_id,
    outcome: "partial_policy_exclusions" as const,
    captured_at: "2026-09-05T00:00:00.000Z",
    policy_sha256: "b".repeat(64),
    exclude_larger_than_bytes: "100",
    excluded_files: "1",
    acknowledged_files: "0",
    next_cursor: null,
    files: [
      {
        path_hex: "67656f2e646174",
        apparent_bytes: "101",
        acknowledgement_key: key,
      },
    ],
  };
}
beforeAll(() => Object.assign(globalThis, { TextDecoder }));
beforeEach(() => {
  jest.resetAllMocks();
  ack.mockResolvedValue([]);
  get.mockResolvedValue(page());
});

it("loads authoritative preferences and confirms acknowledgement before collapsing", async () => {
  render(<BackupCoverage project_id="project-a" />);
  const checkbox = await screen.findByRole("checkbox", {
    name: /I understand this file is not backed up/,
  });
  expect(get).toHaveBeenCalledWith(
    expect.objectContaining({
      project_id: "project-a",
      acknowledgement_keys: [],
    }),
  );
  let approve!: () => void;
  ack.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        approve = () => resolve([key]);
      }),
  );
  checkbox.focus();
  fireEvent.click(checkbox);
  expect(checkbox).not.toBeChecked();
  expect(ack).toHaveBeenLastCalledWith({ project_id: "project-a", key });
  ack.mockResolvedValue([key]);
  get.mockResolvedValue({ ...page(), acknowledged_files: "1" });
  await act(async () => approve());
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Show backup details" }),
    ).toHaveFocus(),
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "these files are still not backed up",
  );
});

it("keeps failed acknowledgements visible", async () => {
  render(<BackupCoverage project_id="project-a" />);
  const checkbox = await screen.findByRole("checkbox");
  ack.mockRejectedValueOnce(new Error("network"));
  fireEvent.click(checkbox);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "No acknowledgement was confirmed",
  );
  expect(checkbox).not.toBeChecked();
});

it("does not confuse unknown evidence with a complete backup and supports retry", async () => {
  get.mockResolvedValueOnce(null);
  render(<BackupCoverage project_id="project-a" />);
  expect(
    await screen.findByText(/No verified backup coverage report/),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh backup coverage" }),
  );
  expect(await screen.findByRole("checkbox")).toBeInTheDocument();
});

it("never renders a stale response from a previous project", async () => {
  let resolve!: (value: any) => void;
  get.mockImplementationOnce(
    () =>
      new Promise((yes) => {
        resolve = yes;
      }),
  );
  const { rerender } = render(<BackupCoverage project_id="project-a" />);
  await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
  get.mockResolvedValue(page("project-b"));
  rerender(<BackupCoverage project_id="project-b" />);
  await screen.findByRole("checkbox");
  await act(async () => resolve({ ...page(), excluded_files: "999" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Backup excludes 1 file",
  );
});

it("pins subsequent pages to the selected backup", async () => {
  get.mockResolvedValueOnce({ ...page(), next_cursor: "cursor" });
  render(<BackupCoverage project_id="project-a" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Next excluded files" }),
  );
  await waitFor(() =>
    expect(get).toHaveBeenLastCalledWith({
      project_id: "project-a",
      backup_id,
      cursor: "cursor",
      acknowledgement_keys: [],
    }),
  );
});
