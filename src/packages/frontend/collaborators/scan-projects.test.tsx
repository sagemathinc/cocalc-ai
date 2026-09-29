import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScanProjects } from "./scan-projects";
import type { DirectoryApi } from "./workspace-api";
const accountId = "account";
function setup() {
  let operation: any;
  let enabled = true;
  const scanProjects = jest.fn(async (request: any) => {
    if (request.action === "projects")
      return {
        enabled,
        total: 30,
        projects: [{ project_id: "first", title: "First project" }],
        next: "cursor",
      };
    if (request.action === "start")
      operation = {
        op_id: "batch",
        status: "running",
        cancelling: false,
        total: request.project_ids === "all" ? 30 : request.project_ids.length,
        processed: 0,
        counts: {},
        children: [],
        next_eligible_at: 0,
      };
    if (request.action === "cancel")
      operation = { ...operation, cancelling: true };
    return { enabled, operation };
  });
  const api = { scanProjects } as unknown as DirectoryApi;
  return {
    scanProjects,
    api,
    user: userEvent.setup(),
    render: () => render(<ScanProjects api={api} accountId={accountId} />),
    disable: () => {
      enabled = false;
    },
  };
}
beforeEach(() => sessionStorage.clear());
test("keyboard selection starts a fixed all-project batch and escape restores focus", async () => {
  const f = setup();
  f.render();
  await f.user.tab();
  expect(screen.getByRole("button", { name: "Scan projects" })).toHaveFocus();
  await f.user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", { name: "Scan projects" });
  const all = await within(dialog).findByRole("checkbox", {
    name: "Select all eligible projects (30)",
  });
  all.focus();
  await f.user.keyboard(" ");
  const start = screen.getByRole("button", { name: "Start scan" });
  start.focus();
  await f.user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("0 of 30"),
  );
  expect(
    f.scanProjects.mock.calls.find(([r]) => r.action === "start")![0]
      .project_ids,
  ).toBe("all");
  await f.user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Scan projects" })).toHaveFocus(),
  );
  await f.user.keyboard("{Enter}");
  await screen.findByRole("status");
  expect(
    f.scanProjects.mock.calls.filter(([r]) => r.action === "start"),
  ).toHaveLength(1);
});
test("disabled admission keeps cancellation and status inspectable", async () => {
  const f = setup();
  f.render();
  await f.user.click(screen.getByRole("button", { name: "Scan projects" }));
  await f.user.click(
    await screen.findByRole("checkbox", { name: "First project" }),
  );
  await f.user.click(screen.getByRole("button", { name: "Start scan" }));
  await screen.findByRole("status");
  f.disable();
  await f.user.click(
    screen.getByRole("button", { name: "Refresh scan status" }),
  );
  await waitFor(() =>
    expect(screen.getByText(/New scans are disabled/)).toBeInTheDocument(),
  );
  const cancel = screen.getByRole("button", { name: "Cancel scan" });
  cancel.focus();
  await f.user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Cancelling"),
  );
  expect(screen.getByRole("button", { name: "Start scan" })).toBeDisabled();
});
test("a lost submission is recovered without resubmitting on reopen", async () => {
  const f = setup();
  const first = f.render();
  await f.user.click(screen.getByRole("button", { name: "Scan projects" }));
  await f.user.click(
    await screen.findByRole("checkbox", { name: "First project" }),
  );
  f.scanProjects.mockRejectedValueOnce(Error("timeout"));
  await f.user.click(screen.getByRole("button", { name: "Start scan" }));
  await screen.findByRole("alert");
  const saved = JSON.parse(
    sessionStorage.getItem("people-scan-batch:account")!,
  );
  first.unmount();
  f.render();
  await f.user.click(screen.getByRole("button", { name: "Scan projects" }));
  const retry = await screen.findByRole("button", {
    name: "Retry same scan request",
  });
  await waitFor(() => expect(retry).toBeEnabled());
  await f.user.click(retry);
  await screen.findByRole("status");
  const starts = f.scanProjects.mock.calls.filter(
    ([r]) => r.action === "start",
  );
  expect(starts.map(([r]) => r.request_id)).toEqual([
    saved.request_id,
    saved.request_id,
  ]);
});
