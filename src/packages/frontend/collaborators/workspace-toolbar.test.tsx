/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceToolbar } from "./workspace-toolbar";
import type { CollaboratorsView } from "./workspace-types";
import { collaboratorsTargetPath } from "./routing";

jest.mock("@cocalc/frontend/components/icon", () => ({ Icon: () => null }));
jest.mock("./project-pins", () => ({ ProjectViewControls: () => null }));
jest.mock("@cocalc/frontend/components/collection", () => ({
  CollectionViewControl: ({ label }) => <button>{label} layout</button>,
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ erase_active_key_handler: jest.fn() }) },
}));

function Toolbar({
  initial = "people",
  onNavigate = jest.fn(),
  onAction = jest.fn(),
}: {
  initial?: CollaboratorsView;
  onNavigate?: (path: string) => void;
  onAction?: () => void;
}) {
  const [view, setView] = useState(initial);
  return (
    <>
      <WorkspaceToolbar
        active
        id="workspace"
        view={view}
        onView={(next) => {
          setView(next);
          onNavigate(collaboratorsTargetPath({ view: next }));
        }}
        input=""
        onInput={jest.fn()}
        scope="for-you"
        onScope={jest.fn()}
        projectView="recent"
        onProjectView={jest.fn()}
        preferences={{
          value: { view: "list", order: [] },
          error: undefined,
          setView: jest.fn(),
          setOrder: jest.fn(),
          retry: jest.fn(),
        }}
        onProjectFilter={jest.fn()}
        onPersonFilter={jest.fn()}
        onClearProject={jest.fn()}
        onClearPerson={jest.fn()}
        onAction={onAction}
      />
      <div
        role="tabpanel"
        id={`workspace-panel-${view}`}
        aria-labelledby={`workspace-tab-${view}`}
      />
    </>
  );
}

test("all People tabs select canonical destinations by accessible name", async () => {
  const user = userEvent.setup();
  const onNavigate = jest.fn();
  render(<Toolbar onNavigate={onNavigate} />);
  const tabs = within(screen.getByRole("tablist", { name: "People views" }));
  for (const [name, path] of [
    ["Conversations", "conversations"],
    ["Collaborators", "collaborators"],
    ["Shared projects", "projects"],
    ["Invites", "invites"],
  ]) {
    const tab = tabs.getByRole("tab", { name });
    await user.click(tab);
    expect(onNavigate).toHaveBeenLastCalledWith(`people/${path}`);
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(tab).toHaveAttribute("tabindex", "0");
    expect(tab).toHaveAttribute(
      "aria-controls",
      screen.getByRole("tabpanel", { name }).id,
    );
    for (const other of tabs.getAllByRole("tab")) {
      if (other === tab) continue;
      expect(other).toHaveAttribute("aria-selected", "false");
      expect(other).toHaveAttribute("tabindex", "-1");
    }
  }
});

test("Invites participates in arrow, Home and End navigation with roving focus", async () => {
  const user = userEvent.setup();
  const onNavigate = jest.fn();
  render(<Toolbar onNavigate={onNavigate} />);
  await user.tab();
  expect(screen.getByRole("tab", { name: "Collaborators" })).toHaveFocus();
  for (const [key, name, path] of [
    ["{End}", "Invites", "invites"],
    ["{ArrowRight}", "Conversations", "conversations"],
    ["{ArrowLeft}", "Invites", "invites"],
    ["{ArrowLeft}", "Shared projects", "projects"],
    ["{Home}", "Conversations", "conversations"],
    ["{ArrowRight}", "Collaborators", "collaborators"],
  ]) {
    await user.keyboard(key);
    const tab = screen.getByRole("tab", { name });
    expect(tab).toHaveFocus();
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(onNavigate).toHaveBeenLastCalledWith(`people/${path}`);
  }
  await user.keyboard("{End}{Tab}");
  expect(screen.getByRole("textbox", { name: "Search invites" })).toHaveFocus();
  await user.tab({ shift: true });
  expect(screen.getByRole("tab", { name: "Invites" })).toHaveFocus();
});

test("Invites uses its own search and Invite action, not conversation controls", async () => {
  const user = userEvent.setup();
  const onAction = jest.fn();
  render(<Toolbar initial="invites" onAction={onAction} />);
  expect(screen.getByRole("textbox", { name: "Search invites" })).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Invitations layout" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "New conversation" })).toBeNull();
  await user.tab();
  await user.tab();
  await user.tab();
  await user.tab();
  await user.tab();
  expect(
    screen.getByRole("button", { name: "Invite", exact: true }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onAction).toHaveBeenCalledTimes(1);
});
