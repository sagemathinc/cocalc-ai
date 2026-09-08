/** @jest-environment jsdom */

import { TextDecoder } from "node:util";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BackupCoverageView } from "@cocalc/util/types/backup-coverage";
import BackupCoveragePanel, { excludedPathLabel } from "./coverage-panel";

beforeAll(() => {
  Object.assign(globalThis, { TextDecoder });
});

function view(overrides: Partial<BackupCoverageView> = {}): BackupCoverageView {
  return {
    schema_version: 1,
    project_id: "project-a",
    backup_id: "a".repeat(64),
    outcome: "partial_policy_exclusions",
    captured_at: "2026-09-05T00:00:00.000Z",
    policy_sha256: "b".repeat(64),
    exclude_larger_than_bytes: "107374182400",
    excluded_files: "1",
    unacknowledged_files: "1",
    next_cursor: null,
    report_available: true,
    files: [
      {
        path_hex: "67656f2e646174",
        apparent_bytes: "1099511627776",
        acknowledgement_key: "c".repeat(64),
        acknowledged: false,
      },
    ],
    ...overrides,
  };
}

function props(coverage = view()) {
  return {
    coverage,
    acknowledge: jest.fn(async () => {}),
    downloadReport: jest.fn(async () => {}),
    nextPage: jest.fn(async (_cursor: string) => {}),
  };
}

it("shows explicit per-file consent without claiming completeness or granting omission", async () => {
  const p = props();
  render(<BackupCoveragePanel {...p} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Backup excludes 1 file",
  );
  expect(screen.getByText(/does not back up a file/)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Hide backup details" }),
  ).toHaveAttribute("aria-expanded", "true");
  const checkbox = screen.getByRole("checkbox", {
    name: "Acknowledge this version; I understand this file is not backed up: geo.dat",
  });
  expect(checkbox).not.toBeChecked();
  checkbox.focus();
  expect(checkbox).toHaveFocus();
  fireEvent.click(checkbox);
  await waitFor(() =>
    expect(p.acknowledge).toHaveBeenCalledWith(p.coverage.files[0]),
  );
  // Success of the request alone cannot invent the authoritative checked state.
  expect(checkbox).not.toBeChecked();
});

it("collapses acknowledged warnings, restores focus, and preserves quiet disclosure/report access", async () => {
  const p = props();
  const { rerender } = render(<BackupCoveragePanel {...p} />);
  screen.getByRole("checkbox").focus();
  rerender(
    <BackupCoveragePanel
      {...p}
      coverage={view({
        unacknowledged_files: "0",
        files: [{ ...p.coverage.files[0], acknowledged: true }],
      })}
    />,
  );
  const toggle = screen.getByRole("button", { name: "Show backup details" });
  expect(toggle).toHaveFocus();
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("still not backed up");
  fireEvent.click(
    screen.getByRole("button", { name: "Download exclusion report" }),
  );
  await waitFor(() => expect(p.downloadReport).toHaveBeenCalledTimes(1));
});

it("does not reopen unchanged acknowledgements for a new backup ID, but reopens new warnings", () => {
  const p = props(view({ unacknowledged_files: "0" }));
  const { rerender } = render(<BackupCoveragePanel {...p} />);
  rerender(
    <BackupCoveragePanel
      {...p}
      coverage={{ ...p.coverage, backup_id: "d".repeat(64) }}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Show backup details" }),
  ).toHaveAttribute("aria-expanded", "false");
  rerender(<BackupCoveragePanel {...p} coverage={view()} />);
  expect(
    screen.getByRole("button", { name: "Hide backup details" }),
  ).toHaveAttribute("aria-expanded", "true");
});

it("reports failures without silently checking a file", async () => {
  const p = props();
  p.acknowledge.mockRejectedValue(
    new Error("private error must not be displayed"),
  );
  render(<BackupCoveragePanel {...p} />);
  fireEvent.click(screen.getByRole("checkbox"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "No acknowledgement was confirmed",
  );
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(
    screen.queryByText("private error must not be displayed"),
  ).not.toBeInTheDocument();
});

it("disables uncertain file identity rather than hiding its warning", () => {
  const p = props();
  p.coverage.files[0].acknowledgement_key = null;
  render(<BackupCoveragePanel {...p} />);
  expect(screen.getByRole("checkbox")).toBeDisabled();
  expect(screen.getByText(/cannot be acknowledged yet/)).toBeInTheDocument();
});

it("paginates explicitly and does not acknowledge unseen files", async () => {
  const p = props(
    view({
      excluded_files: "1000",
      unacknowledged_files: "1000",
      next_cursor: "opaque-cursor",
    }),
  );
  render(<BackupCoveragePanel {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "Next excluded files" }));
  await waitFor(() => expect(p.nextPage).toHaveBeenCalledWith("opaque-cursor"));
  expect(p.acknowledge).not.toHaveBeenCalled();
});

it("keeps failed and complete outcomes distinct from partial-backup consent", () => {
  const p = props(view({ outcome: "failed" }));
  const { rerender } = render(<BackupCoveragePanel {...p} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "failed or could not be verified",
  );
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  rerender(
    <BackupCoveragePanel {...p} coverage={view({ outcome: "complete" })} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Later edits may still need a backup",
  );
});

it("keeps huge exact sizes and hostile names as inert readable text", () => {
  const p = props();
  p.coverage.files[0].path_hex = Buffer.from("<img src=x>\n\u202e").toString(
    "hex",
  );
  render(<BackupCoveragePanel {...p} />);
  expect(screen.getByRole("checkbox")).toHaveAccessibleName(
    /<img src=x>\\u000a\\u202e/,
  );
  expect(screen.getByText(/1,099,511,627,776 bytes/)).toBeInTheDocument();
  expect(document.querySelector("img")).toBeNull();
  expect(excludedPathLabel("ff0a5c")).toBe("\\xff\\x0a\\x5c");
  expect(excludedPathLabel("fe0a5c")).not.toBe(excludedPathLabel("ff0a5c"));
});

it("does not label a missing limit as zero", () => {
  render(
    <BackupCoveragePanel
      {...props(view({ exclude_larger_than_bytes: null }))}
    />,
  );
  expect(screen.getByText(/larger than unknown size/)).toBeInTheDocument();
});
