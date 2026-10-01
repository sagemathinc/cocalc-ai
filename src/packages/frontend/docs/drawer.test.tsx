/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppDocsDrawer } from "./drawer";
import { DocsLink } from "./link";
import { openAppDocsDrawer } from "./navigation";

const mockSetActiveTab = jest.fn();
const mockMount = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => ({
      set_active_tab: mockSetActiveTab,
      erase_active_key_handler: jest.fn(),
    }),
  },
}));
jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "/",
}));
jest.mock("@cocalc/frontend/project/page/flyouts/docs", () => ({
  ProjectDocsPanel: ({ request }) => {
    // Track browser lifetime independently from its selected guide.
    require("react").useEffect(() => {
      mockMount();
    }, []);
    return (
      <label>
        Docs search
        <input aria-label="Docs search" defaultValue={request.slug} />
      </label>
    );
  },
}));

describe("contextual documentation drawer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
  });

  it("opens a guide from the keyboard, keeps the route and browser state, and restores focus on Escape", async () => {
    const user = userEvent.setup();
    render(
      <>
        <DocsLink drawer slug="collaboration/scan-files">
          How indexing and manual scans work
        </DocsLink>
        <button
          onClick={(event) => openAppDocsDrawer(undefined, event.currentTarget)}
        >
          More navigation
        </button>
        <AppDocsDrawer />
      </>,
    );
    const link = screen.getByRole("link", {
      name: "How indexing and manual scans work",
    });
    const url = window.location.href;
    expect(link).toHaveAttribute("href", "/docs/collaboration/scan-files");
    await user.tab();
    expect(link).toHaveFocus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Documentation" });
    const search = await within(dialog).findByRole("textbox", {
      name: "Docs search",
    });
    expect(search).toHaveValue("collaboration/scan-files");
    await user.click(search);
    await user.clear(search);
    await user.type(search, "retained search");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(link).toHaveFocus());
    await user.keyboard("{Enter}");
    const reopened = await screen.findByRole("dialog", {
      name: "Documentation",
    });
    expect(
      within(reopened).getByRole("textbox", { name: "Docs search" }),
    ).toHaveValue("retained search");
    expect(mockMount).toHaveBeenCalledTimes(1);
    expect(mockSetActiveTab).not.toHaveBeenCalled();
    expect(window.location.href).toBe(url);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(link).toHaveFocus());
    const menuTrigger = screen.getByRole("button", { name: "More navigation" });
    await user.click(menuTrigger);
    await screen.findByRole("dialog", { name: "Documentation" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(menuTrigger).toHaveFocus());
  });

  it("preserves modified-link navigation for opening docs in another tab", () => {
    render(
      <>
        <DocsLink drawer slug="collaboration/scan-files">
          Scan guide
        </DocsLink>
        <AppDocsDrawer />
      </>,
    );
    const link = screen.getByRole("link", { name: "Scan guide" });
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockSetActiveTab).not.toHaveBeenCalled();
  });

  it("restores a persistent menu trigger rather than its removed item", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button
          onClick={(event) => openAppDocsDrawer(undefined, event.currentTarget)}
        >
          Documentation menu
        </button>
        <AppDocsDrawer />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Documentation menu" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Documentation" });
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(mockSetActiveTab).not.toHaveBeenCalled();
  });
});
