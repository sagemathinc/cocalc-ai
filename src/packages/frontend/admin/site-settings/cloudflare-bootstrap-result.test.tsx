/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CloudflareBootstrapResult } from "@cocalc/conat/hub/api/system";
import CloudflareBootstrapResultView from "./cloudflare-bootstrap-result";

const success: CloudflareBootstrapResult = {
  permissions: ["Workers Scripts Write"],
  notes: [],
  values: {},
  account_name: "Test account",
  durable_token_id: "durable-id",
  bootstrap_token_invalidated: true,
  bootstrap_token_id: "temporary-id",
  tunnel_token: { ok: true },
  visitor_location_headers: { ok: true },
  r2: { ok: true },
};

it("shows one success alert with focusable collapsed details", async () => {
  const user = userEvent.setup();
  render(<CloudflareBootstrapResultView result={success} />);
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByText("Cloudflare configuration saved")).toBeVisible();
  const summary = screen.getByText("Details", { selector: "summary" });
  const details = summary.closest("details")!;
  expect(details.open).toBe(false);
  expect(screen.getByText("Test account")).not.toBeVisible();
  await user.tab();
  expect(summary).toHaveFocus();
  await user.click(summary);
  expect(details.open).toBe(true);
  expect(screen.getByText("Test account")).toBeVisible();
  expect(screen.getByText(/Temporary bootstrap token revoked/)).toBeVisible();
  await user.click(summary);
  expect(details.open).toBe(false);
  expect(summary).toHaveFocus();
});

it("keeps failed checks and bootstrap cleanup visible without expanding details", () => {
  render(
    <CloudflareBootstrapResultView
      result={{
        ...success,
        bootstrap_token_invalidated: false,
        visitor_location_headers: {
          ok: false,
          message: "Run the visitor-header check again.",
        },
      }}
    />,
  );
  expect(
    screen.getByText(
      "Delete the temporary bootstrap token manually in Cloudflare",
    ),
  ).toBeVisible();
  expect(
    screen.getByText(/Run the visitor-header check again/, { selector: "div" }),
  ).toBeVisible();
});

it("keeps unsuccessful setup diagnostics expanded", () => {
  render(
    <CloudflareBootstrapResultView
      result={{
        ...success,
        tunnel_token: { ok: false },
        settings_status: "not_saved",
        failure: "Invalid discovery expiry",
      }}
    />,
  );
  expect(screen.getByText("Invalid discovery expiry")).toBeVisible();
  expect(screen.queryByText("Details", { selector: "summary" })).toBeNull();
});

it("shows only propagation recovery advice for a saved partial failure", () => {
  render(
    <CloudflareBootstrapResultView
      result={{
        ...success,
        settings_status: "saved",
        tunnel_token: {
          ok: false,
          message: "Retry with a new bootstrap token.",
        },
        failure:
          "Propagation failed. Synchronize site settings; keep old and new credentials active.",
      }}
    />,
  );
  expect(screen.getByText(/Propagation failed/)).toBeVisible();
  expect(screen.getByText(/Settings were saved on the seed bay/)).toBeVisible();
  expect(document.body).not.toHaveTextContent(
    "Retry with a new bootstrap token",
  );
  expect(document.body).not.toHaveTextContent(
    "Saving may have partially completed",
  );
});

it("does not collapse a failed discovery-token cleanup into success details", () => {
  render(
    <CloudflareBootstrapResultView
      result={{
        ...success,
        cleanup_required: true,
        notes: [
          "Delete temporary or unsaved Cloudflare token discovery-id manually in API Tokens.",
        ],
      }}
    />,
  );
  expect(
    screen.getByText("Temporary Cloudflare tokens need manual cleanup"),
  ).toBeVisible();
  expect(
    screen
      .getAllByText(/Delete temporary or unsaved/)
      .some((node) => !node.closest("details")),
  ).toBe(true);
});
