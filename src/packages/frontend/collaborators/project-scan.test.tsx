import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectScan } from "./project-scan";
import type { DirectoryApi } from "./workspace-api";

jest.setTimeout(30000);

const props = { accountId: "account", projectId: "project" };
const storageKey = "people-scan:account:project";
function setup() {
  const api = {
    requestScan: jest.fn().mockResolvedValue({
      admission: "accepted",
      job_id: "job",
      expires_at: Date.now() + 60000,
    }),
    inspectScan: jest.fn().mockResolvedValue({
      allowed: true,
      value: { job_id: "job" },
      poll_after_ms: 1000,
    }),
    getScanStatus: jest.fn().mockResolvedValue({
      allowed: true,
      value: { state: "discovered" },
      poll_after_ms: 1000,
    }),
  };
  const renderScan = () =>
    render(<ProjectScan {...props} api={api as unknown as DirectoryApi} />);
  return {
    api,
    renderScan,
    user: userEvent.setup(),
  };
}
beforeEach(() => {
  sessionStorage.clear();
});
const advance = (ms = 5000) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });

test("keyboard admission and status distinguish discovery from projection", async () => {
  const { api, user, renderScan } = setup();
  renderScan();
  await user.tab();
  expect(screen.getByRole("button", { name: "Scan project" })).toHaveFocus();
  await user.keyboard("{Enter}");
  await settle();
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Scan queued"),
  );
  expect(api.requestScan).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(storageKey)).toBe(
    api.requestScan.mock.calls[0][0].request_id,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Scan queued");
  expect(
    screen.getByRole("button", { name: "Check Scan status" }),
  ).toBeDisabled();
  await advance();
  const status = screen.getByRole("button", { name: "Check Scan status" });
  await waitFor(() => expect(status).toBeEnabled());
  status.focus();
  await user.keyboard("{Enter}");
  await settle();
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Discovery finished"),
  );
  expect(api.getScanStatus).toHaveBeenCalledWith({
    project_id: "project",
    job_id: "job",
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "People views may still be catching up",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Files changed during the scan may need another scan",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "this is not a point-in-time snapshot",
  );
  expect(screen.getByRole("status")).toHaveFocus();
  expect(sessionStorage.getItem(storageKey)).toBeNull();
  await advance();
  expect(api.getScanStatus).toHaveBeenCalledTimes(1);
  expect(api.requestScan).toHaveBeenCalledTimes(1);
});

test("lost response survives remount and inspection never sends another request", async () => {
  const { api, user, renderScan } = setup();
  api.requestScan.mockRejectedValueOnce(Error("timeout"));
  const first = renderScan();
  await user.click(screen.getByRole("button", { name: "Scan project" }));
  await settle();
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "could not be confirmed",
    ),
  );
  const request_id = sessionStorage.getItem(storageKey);
  expect(request_id).toBeTruthy();
  first.unmount();
  renderScan();
  await user.click(screen.getByRole("button", { name: "Check Scan status" }));
  await settle();
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("receipt recovered"),
  );
  expect(api.inspectScan).toHaveBeenCalledWith({
    project_id: "project",
    request_id,
  });
  expect(api.requestScan).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status")).toHaveTextContent("receipt recovered");
});

test("throttled retries retain the identity and respect the cooldown", async () => {
  const { api, user, renderScan } = setup();
  api.requestScan.mockResolvedValueOnce({
    admission: "throttled",
    retry_after_ms: 10000,
  });
  renderScan();
  await user.click(screen.getByRole("button", { name: "Scan project" }));
  await settle();
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Scan is throttled"),
  );
  const button = screen.getByRole("button", { name: "Retry same Scan" });
  expect(button).toBeDisabled();
  await advance(9000);
  expect(button).toBeDisabled();
  await advance(1000);
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  await settle();
  await waitFor(() => expect(api.requestScan).toHaveBeenCalledTimes(2));
  expect(api.requestScan.mock.calls[1][0]).toEqual(
    api.requestScan.mock.calls[0][0],
  );
});

test("an older API does not expose the control", () => {
  render(<ProjectScan {...props} api={{} as DirectoryApi} />);
  expect(screen.queryByRole("button", { name: "Scan project" })).toBeNull();
});

test("missing receipt allows explicit forgetting without silently submitting work", async () => {
  const { api, user, renderScan } = setup();
  const previous = "00000000-0000-4000-8000-000000000001";
  sessionStorage.setItem(storageKey, previous);
  api.inspectScan.mockResolvedValue({
    allowed: true,
    value: null,
    poll_after_ms: 1000,
  });
  renderScan();
  expect(
    screen.queryByRole("button", { name: "Forget saved request" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "Check Scan status" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "earlier work may still be running",
    ),
  );
  await advance(1100);
  const forget = screen.getByRole("button", { name: "Forget saved request" });
  await waitFor(() => expect(forget).toBeEnabled());
  forget.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Scan project" })).toBeEnabled(),
  );
  expect(screen.getByRole("status")).toHaveFocus();
  expect(sessionStorage.getItem(storageKey)).toBeNull();
  expect(api.requestScan).not.toHaveBeenCalled();
  await user.tab();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(api.requestScan).toHaveBeenCalledTimes(1));
  expect(api.requestScan.mock.calls[0][0].request_id).not.toBe(previous);
});

test("an ambiguous inspection does not offer to forget the saved identity", async () => {
  const { api, user, renderScan } = setup();
  const previous = "00000000-0000-4000-8000-000000000001";
  sessionStorage.setItem(storageKey, previous);
  api.inspectScan.mockRejectedValue(Error("timeout"));
  renderScan();
  await user.click(screen.getByRole("button", { name: "Check Scan status" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "could not be confirmed",
    ),
  );
  expect(
    screen.queryByRole("button", { name: "Forget saved request" }),
  ).toBeNull();
  expect(sessionStorage.getItem(storageKey)).toBe(previous);
  expect(api.requestScan).not.toHaveBeenCalled();
});

test("host cooldown has an explanation and prevents immediate status polling", async () => {
  const { api, user, renderScan } = setup();
  api.getScanStatus.mockResolvedValue({
    allowed: true,
    value: {
      state: "running",
      deferred: { reason: "host_throttled", retry_after_ms: 120000 },
    },
    poll_after_ms: 1000,
  });
  renderScan();
  await user.click(screen.getByRole("button", { name: "Scan project" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Scan queued"),
  );
  await advance();
  const status = screen.getByRole("button", { name: "Check Scan status" });
  await waitFor(() => expect(status).toBeEnabled());
  await user.click(status);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "host's reconciliation cooldown",
    ),
  );
  expect(status).toBeDisabled();
  expect(api.requestScan).toHaveBeenCalledTimes(1);
  expect(api.getScanStatus).toHaveBeenCalledTimes(1);
});

test("saved recovery identifiers are scoped to the current account and project", () => {
  const { api } = setup();
  sessionStorage.setItem(storageKey, "00000000-0000-4000-8000-000000000001");
  render(
    <ProjectScan
      accountId="another-account"
      projectId="project"
      api={api as unknown as DirectoryApi}
    />,
  );
  expect(screen.getByRole("button", { name: "Scan project" })).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Check Scan status" }),
  ).toBeNull();
  expect(api.requestScan).not.toHaveBeenCalled();
  expect(api.inspectScan).not.toHaveBeenCalled();
});

test("requests are not submitted if durable session recovery cannot be saved", async () => {
  const { api, user, renderScan } = setup();
  const set = jest
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw Error("quota");
    });
  try {
    renderScan();
    await user.click(screen.getByRole("button", { name: "Scan project" }));
    expect(api.requestScan).not.toHaveBeenCalled();
  } finally {
    set.mockRestore();
  }
});
