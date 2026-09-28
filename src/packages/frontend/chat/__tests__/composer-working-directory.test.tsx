/** @jest-environment jsdom */
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComposerWorkingDirectory } from "../composer-working-directory";
import {
  HarnessRuntimeControl,
  qualifiedHarnessRuntime,
} from "../harness-profile";

// AntD's Jest-only constant ID mislabels dialogs after a popover was opened.
jest.mock("@rc-component/util/lib/hooks/useId", () => ({
  __esModule: true,
  ...jest.requireActual("@rc-component/util/lib/hooks/useId"),
  default: (id?: string) => {
    const generated = jest.requireActual("react").useId();
    return id ?? generated;
  },
}));

jest.mock("@cocalc/frontend/project/directory-selector", () => ({
  __esModule: true,
  default: ({ onSelect }) => (
    <button onClick={() => onSelect("/home/user/chosen")}>
      Select chosen directory
    </button>
  ),
}));

test("Claude composer puts the shared directory control first and icon settings last", async () => {
  const user = userEvent.setup();
  const changed = jest.fn();
  function Composer() {
    const [directory, setDirectory] = useState("/home/user");
    return (
      <HarnessRuntimeControl
        compact
        runtime={qualifiedHarnessRuntime("claude-code", directory)}
        configureLabel="Claude Code settings"
        leadingControl={
          <ComposerWorkingDirectory
            projectId="project"
            projectTitle="My project"
            directory={directory}
            home="/home/user"
            onChange={(value) => {
              changed(value);
              setDirectory(value);
            }}
          />
        }
        onSettings={jest.fn()}
      />
    );
  }
  render(<Composer />);
  const trigger = screen.getByRole("button", {
    name: "Working directory: My project / /home/user",
  });
  const settings = screen.getByRole("button", { name: "Claude Code settings" });
  expect(
    trigger.compareDocumentPosition(settings) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(settings.textContent).toBe("");
  trigger.focus();
  await user.keyboard("{Enter}");
  const input = await screen.findByRole("textbox", {
    name: "Working directory",
  });
  await user.clear(input);
  await user.type(input, "~/work{Enter}");
  expect(changed).toHaveBeenCalledWith("/home/user/work");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(
    screen.getByRole("button", {
      name: "Working directory: My project / /home/user/work",
    }),
  ).toBe(trigger);
  await user.keyboard("{Enter}");
  await user.click(
    await screen.findByRole("button", { name: "Choose directory..." }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Select chosen directory" }),
  );
  expect(changed).toHaveBeenLastCalledWith("/home/user/chosen");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(settings.isConnected).toBe(true);
  settings.focus();
  expect(document.activeElement).toBe(settings);
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", {
    name: "Claude Code settings",
  });
  expect(dialog).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(settings));
});

test("Escape discards the directory draft and restores focus", async () => {
  const changed = jest.fn();
  const user = userEvent.setup();
  render(
    <ComposerWorkingDirectory
      projectTitle="Project"
      directory="/home/user"
      home="/home/user"
      onChange={changed}
    />,
  );
  const trigger = screen.getByRole("button", {
    name: "Working directory: Project / /home/user",
  });
  await user.click(trigger);
  await user.type(
    await screen.findByRole("textbox", { name: "Working directory" }),
    "/draft{Escape}",
  );
  expect(changed).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
});
