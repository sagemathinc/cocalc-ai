import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlusRestartIndicator } from "./update-indicator";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => new Map(),
  redux: { getActions: () => ({ set_other_settings: jest.fn() }) },
}));
jest.mock("./frontend-build-monitor", () => ({
  reloadForFrontendBuild: jest.fn(),
  useFrontendBuildMonitor: () => ({ reloadRecommended: false }),
}));
jest.mock("@cocalc/frontend/lite", () => ({ lite: true }));
jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "/",
}));
// rc-component's useId returns the same "test-id" for everything under
// NODE_ENV=test, which merges the popover's and the dialog's Escape handlers
// and labels. Real (unique) ids, as in a browser:
jest.mock("@rc-component/util/lib/hooks/useId", () => ({
  __esModule: true,
  default: (id?: string) => {
    const generated = require("react").useId();
    return id ?? generated;
  },
}));

function mockStatus(status: object) {
  (global as any).fetch = jest.fn(async () => ({
    ok: true,
    json: async () => status,
  }));
}

describe("CoCalc Plus restart-to-update indicator", () => {
  it("shows nothing when the running release is current", async () => {
    mockStatus({ restartToApply: false });
    const { container } = render(<PlusRestartIndicator />);
    await waitFor(() => expect((global as any).fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("is keyboard accessible: the pill, its action, and a dialog Escape closes", async () => {
    mockStatus({
      restartToApply: true,
      running: { release: 1, version: "1.0.1" },
      installed: { release: 2, version: "1.0.2" },
    });
    render(<PlusRestartIndicator />);
    const user = userEvent.setup();
    const pill = await screen.findByRole("button", {
      name: /^Restart to update: CoCalc Plus 1\.0\.2 is installed/,
    });
    // Reach the pill with the keyboard and open it.
    await user.tab();
    expect(pill).toHaveFocus();
    await user.keyboard("{Enter}");
    const action = await screen.findByRole("button", {
      name: "How to restart",
    });
    action.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", {
      name: "Restart CoCalc Plus",
      hidden: true,
    });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveTextContent("cocalc-plus update --rollback");
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
    await user.keyboard("{Escape}");
    // Closed: antd hides the dialog once its closing animation ends.
    await waitFor(() => expect(dialog).not.toBeVisible(), { timeout: 3000 });
  });
});
