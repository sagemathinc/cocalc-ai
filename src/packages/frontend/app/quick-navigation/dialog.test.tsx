/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";
import { NavigationDialog } from "./dialog";
import type { Candidate, Editor } from "./model";
jest.mock("./configuration", () => ({
  NavigationConfiguration: () => (
    <label>
      Double-tap interval
      <input />
    </label>
  ),
}));
jest.mock("./navigate", () => ({
  HELP_SLUG: "documentation/quick-navigation",
}));
jest.mock("@cocalc/frontend/components/icon", () => ({ Icon: () => null }));
jest.mock("./quick-navigation.css", () => ({}));
jest.mock("@cocalc/frontend/keyboard/boundary", () => ({
  KeyboardBoundary: ({ children }) => <div>{children}</div>,
}));
jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "",
}));
// rc-util deliberately returns the same ID for every dialog in NODE_ENV=test.
// Use real React IDs so nested modal names have the production semantics.
jest.mock("@rc-component/util/lib/hooks/useId", () => ({
  __esModule: true,
  ...jest.requireActual("@rc-component/util/lib/hooks/useId"),
  default: () => jest.requireActual("react").useId(),
}));
const frames = [
  { id: "source", type: "cm", label: "Source" },
  { id: "pdf", type: "pdf", label: "PDF" },
];
const editor: Editor = {
  projectId: "p",
  path: "paper.tex",
  frames,
  layout: { children: frames.map((frame) => ({ frame })) },
  activeId: "source",
};
const item: Candidate = {
  id: "paper",
  title: "Paper",
  detail: "Algebra › paper.tex",
  priority: 0,
  destination: { kind: "file", projectId: "p", path: "paper.tex" },
  editor,
};
const numeric: Candidate = {
  ...item,
  id: "2026",
  title: "2026.tex",
  detail: "Report",
  destination: { kind: "file", projectId: "p", path: "2026.tex" },
};
function setup() {
  const closed = jest.fn();
  render(
    <IntlProvider locale="en">
      <NavigationDialog
        items={[
          item,
          numeric,
          {
            id: "settings",
            title: "Preferences",
            detail: "Account",
            priority: 40,
            destination: { kind: "settings", page: "editor" },
          },
        ]}
        currentEditor={editor}
        projectId="p"
        onClosed={closed}
      />
    </IntlProvider>,
  );
  return {
    closed,
    input: screen.getByRole("combobox", {
      name: "Search projects, files, frames, and settings",
    }),
  };
}
it("focuses search and opens a frame immediately on an initial digit", async () => {
  const { closed, input } = setup();
  await waitFor(() => expect(document.activeElement).toBe(input));
  await userEvent.type(input, "2");
  await waitFor(() =>
    expect(closed).toHaveBeenCalledWith({
      kind: "file",
      projectId: "p",
      path: "paper.tex",
      frameId: "pdf",
    }),
  );
});
it.each([" 2", " 2026"])(
  "searches a numeric query after a leading space: %s",
  async (query) => {
    const { closed, input } = setup();
    await userEvent.type(input, query);
    expect(closed).not.toHaveBeenCalled();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(closed).toHaveBeenCalledWith(numeric.destination),
    );
  },
);
it("uses Tab for preview, Shift-Tab for search, and immediate digits in preview", async () => {
  const { closed, input } = setup();
  await userEvent.type(input, "paper");
  await userEvent.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("group", { name: "Frames in paper.tex" }),
  );
  expect(closed).not.toHaveBeenCalled();
  expect(screen.getByRole("combobox")).toBe(input);
  expect(screen.getByRole("listbox")).toBeTruthy();
  await userEvent.tab({ shift: true });
  expect((input as HTMLInputElement).value).toBe("paper");
  expect(document.activeElement).toBe(input);
  await userEvent.tab();
  await userEvent.keyboard("2");
  await waitFor(() =>
    expect(closed).toHaveBeenCalledWith(
      expect.objectContaining({ frameId: "pdf" }),
    ),
  );
});
it("supports arrow navigation even with an empty search", async () => {
  const { input } = setup();
  input.focus();
  const before = input.getAttribute("aria-activedescendant");
  await userEvent.keyboard("{ArrowDown}");
  expect(input.getAttribute("aria-activedescendant")).not.toBe(before);
});
it("retains search state after deleting a multi-digit search back to one digit", async () => {
  const { input } = setup();
  await userEvent.type(input, " 20{Backspace}{Home}{Delete}{End}");
  expect((input as HTMLInputElement).value).toBe("2");
  expect(screen.getAllByRole("option")).toHaveLength(1);
});
it("opens separate configuration, restores focus on Escape, and hands off Help to docs", async () => {
  const { closed } = setup();
  const gear = screen.getByRole("button", {
    name: "Configure Quick Navigation",
  });
  await userEvent.click(gear);
  const configuration = screen.getByRole("dialog", {
    name: "Configure Quick Navigation",
  });
  const interval = within(configuration).getByLabelText("Double-tap interval");
  await userEvent.click(interval);
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Configure Quick Navigation" }),
    ).toBeNull(),
  );
  expect(document.activeElement).toBe(gear);
  expect(closed).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Quick Navigation" })).toBeTruthy();
  const help = screen.getByRole("link", { name: "Help" });
  fireEvent.click(help, { ctrlKey: true });
  expect(closed).not.toHaveBeenCalled();
  await userEvent.click(help);
  await waitFor(() =>
    expect(closed).toHaveBeenCalledWith({ kind: "docs", projectId: "p" }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("Escape cancels without a navigation destination", async () => {
  const { closed, input } = setup();
  input.focus();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(closed).toHaveBeenCalledWith(undefined));
});

it("treats pasted numeric filenames as searches rather than frame commands", async () => {
  const { closed, input } = setup();
  fireEvent.change(input, { target: { value: "2026" } });
  expect(closed).not.toHaveBeenCalled();
  expect(screen.getAllByRole("option")).toHaveLength(1);
});

it("keeps a fixed-height list and a natural-height preview column", async () => {
  const { input } = setup();
  const list = screen.getByRole("listbox");
  const columns = screen.getByTestId("quick-nav-columns");
  const left = columns.firstElementChild as HTMLElement;
  const right = columns.lastElementChild as HTMLElement;
  expect(columns.style.gridTemplateColumns).toBe(
    "minmax(0, 2fr) minmax(0, 1fr)",
  );
  expect(columns.style.height).toBe("");
  expect(left.style.height).not.toBe("");
  expect(right.style.height).toBe("");
  expect(
    right.contains(screen.getByRole("group", { name: "Frames in paper.tex" })),
  ).toBe(true);
  expect(screen.getByTestId("frame-preview").style.aspectRatio).toBe("1 / 1");
  await userEvent.type(input, "preferences");
  expect(screen.queryByRole("group", { name: /^Frames in/ })).toBeNull();
  expect(columns.lastElementChild).toBe(right);
  expect(right.childElementCount).toBe(0);
  expect(screen.getByRole("listbox")).toBe(list);
});

it("cycles Tab only through search, preview, configure and help", async () => {
  const { input } = setup();
  await waitFor(() => expect(document.activeElement).toBe(input));
  const preview = screen.getByRole("group", { name: "Frames in paper.tex" });
  const gear = screen.getByRole("button", {
    name: "Configure Quick Navigation",
  });
  const help = screen.getByRole("link", { name: "Help" });
  await userEvent.tab();
  expect(document.activeElement).toBe(preview);
  await userEvent.tab();
  expect(document.activeElement).toBe(gear);
  await userEvent.tab();
  expect(document.activeElement).toBe(help);
  await userEvent.tab();
  expect(document.activeElement).toBe(input);
  await userEvent.tab({ shift: true });
  expect(document.activeElement).toBe(help);
  // Preview buttons are not tab stops, but Tab from one continues the cycle.
  const button = screen.getByRole("button", { name: "2 · PDF" });
  expect(button.tabIndex).toBe(-1);
  button.focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(gear);
});

it("Escape closes even when focus is not inside the dialog", async () => {
  const { closed } = setup();
  (document.activeElement as HTMLElement | null)?.blur();
  expect(document.activeElement).toBe(document.body);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(closed).toHaveBeenCalledWith(undefined));
});

it("0 opens the side chat when the editor has no chat frame, else focuses it", async () => {
  const { closed, input } = setup();
  await waitFor(() => expect(document.activeElement).toBe(input));
  await userEvent.keyboard("0");
  await waitFor(() =>
    expect(closed).toHaveBeenCalledWith({
      kind: "file",
      projectId: "p",
      path: "paper.tex",
      chat: true,
    }),
  );
});

it("0 focuses an existing chat frame from the preview", async () => {
  const closed = jest.fn();
  const chat = { id: "chat", type: "chat", label: "Chat" };
  const withChat: Editor = {
    ...editor,
    frames: [...frames, chat],
    layout: { children: [...frames, chat].map((frame) => ({ frame })) },
  };
  render(
    <IntlProvider locale="en">
      <NavigationDialog
        items={[{ ...item, editor: withChat }]}
        currentEditor={withChat}
        projectId="p"
        onClosed={closed}
      />
    </IntlProvider>,
  );
  const input = screen.getByRole("combobox");
  await waitFor(() => expect(document.activeElement).toBe(input));
  await userEvent.tab();
  await userEvent.keyboard("0");
  await waitFor(() =>
    expect(closed).toHaveBeenCalledWith(
      expect.objectContaining({ frameId: "chat" }),
    ),
  );
});

it("changes the hint with keyboard focus and with what the selection offers", async () => {
  const { input } = setup();
  await waitFor(() => expect(document.activeElement).toBe(input));
  const hintElement = () =>
    document.getElementById(input.getAttribute("aria-describedby")!)!;
  const hint = () => hintElement().textContent;
  expect(hintElement().style.whiteSpace).toBe("nowrap");
  expect(hint()).toContain("Enter opens paper.tex");
  expect(hint()).toContain("1–9 open a frame");
  expect(hint()).toContain("Space first");
  await userEvent.tab();
  expect(hint()).toContain("Enter opens “Source”");
  expect(hint()).toContain("Shift+Tab back to search");
  expect(screen.getByText("Frames of paper.tex")).toBeTruthy();
  expect(screen.getByText("1–9 or Enter")).toBeTruthy();
  await userEvent.tab({ shift: true });
  expect(screen.getByText("Tab, then 1–9")).toBeTruthy();
  await userEvent.type(input, "paper");
  expect(hint()).not.toContain("Space first");
  expect(hint()).toContain("Tab: frame selector");
  await userEvent.clear(input);
  await userEvent.type(input, "preferences");
  expect(hint()).toBe("↑↓ select · Enter opens the selected result");
});

it("opens the configuration from the title bar button", async () => {
  setup();
  expect(
    screen.queryByRole("button", { name: "Configure or disable" }),
  ).toBeNull();
  const configure = screen.getByRole("button", {
    name: "Configure Quick Navigation",
  });
  expect(configure.textContent).toContain("Configure");
  await userEvent.click(configure);
  expect(
    screen.getByRole("dialog", { name: "Configure Quick Navigation" }),
  ).toBeTruthy();
});

it("styles result rows through a class so hover and selection can differ", () => {
  setup();
  const [first, second] = screen.getAllByRole("option");
  expect(first.className).toContain("cc-quick-nav-result");
  expect(first.getAttribute("aria-selected")).toBe("true");
  expect(second.getAttribute("aria-selected")).toBe("false");
  expect(first.style.background).toBe("");
});
