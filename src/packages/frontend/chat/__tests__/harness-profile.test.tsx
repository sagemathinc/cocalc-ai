/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { harnessSessionControls } from "@cocalc/util/ai/harness-controls";
import {
  HarnessProfileFields,
  HarnessRuntimeSummary,
  harnessRuntimeFromDraft,
} from "../harness-profile";

const draft = {
  id: "Pi",
  revision: "0.86.1",
  executable: "/home/user/bin/pi-acp",
  args: "--flag\nvalue with spaces",
};

test("advertised model selector supports keyboard selection for future submissions", async () => {
  const runtime = harnessRuntimeFromDraft(draft, "/home/user");
  const onSettings = jest.fn();
  const reported = {
    profile: runtime.profile,
    controls: harnessSessionControls({
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "fast",
          options: [
            { value: "fast", name: "Fast" },
            { value: "deep", name: "Deep" },
          ],
        },
      ],
    }),
  };
  const { rerender } = render(
    <HarnessRuntimeSummary
      runtime={runtime}
      reported={reported}
      onSettings={onSettings}
    />,
  );
  const user = userEvent.setup();
  const selector = screen.getByRole("combobox", { name: "Model" });
  await user.click(selector);
  await screen.findByRole("option", { name: "Deep" });
  // rc-select reads legacy keyCode, which user-event/jsdom leaves at zero.
  fireEvent.keyDown(selector, { key: "ArrowDown", keyCode: 40 });
  fireEvent.keyDown(selector, { key: "Enter", keyCode: 13 });
  expect(onSettings).toHaveBeenCalledWith({
    configOptions: [{ id: "model", value: "deep" }],
  });
  expect(screen.getByText(/next submitted turn/)).toBeTruthy();
  rerender(
    <HarnessRuntimeSummary
      runtime={runtime}
      reported={{
        ...reported,
        profile: { ...runtime.profile, revision: "different" },
      }}
      onSettings={onSettings}
    />,
  );
  expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
});

test("profile fields have visible labels and support keyboard editing", async () => {
  function Form() {
    const [value, setValue] = useState(draft);
    return <HarnessProfileFields value={value} onChange={setValue} />;
  }
  render(<Form />);
  expect(
    screen.getByText(/Agent Networks support queued messages/),
  ).toBeTruthy();
  expect(screen.getByText(/live guidance are not supported/)).toBeTruthy();
  const user = userEvent.setup();
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "Harness name" }),
  );
  await user.keyboard("{End} test");
  expect(
    (screen.getByRole("textbox", { name: "Harness name" }) as HTMLInputElement)
      .value,
  ).toBe("Pi test");
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "Installed version / revision" }),
  );
  expect(
    screen.getByRole("textbox", { name: "Executable (absolute project path)" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("textbox", {
      name: "Arguments (one per line, no shell quoting)",
    }),
  ).toBeTruthy();
});

test("discovery is explicit, keyboard accessible and does not select a model", async () => {
  const runtime = harnessRuntimeFromDraft(draft, "/home/user");
  const onSettings = jest.fn();
  const onDiscover = jest.fn(async () => ({
    profile: runtime.profile,
    controls: {
      configOptions: [
        {
          id: "model",
          name: "Model",
          currentValue: "local",
          options: [{ value: "local", name: "Local" }],
        },
      ],
    },
  }));
  render(
    <HarnessRuntimeSummary
      runtime={runtime}
      onSettings={onSettings}
      onDiscover={onDiscover}
    />,
  );
  expect(onDiscover).not.toHaveBeenCalled();
  const user = userEvent.setup();
  await user.tab();
  await user.tab();
  const button = screen.getByRole("button", {
    name: "Load model and mode options",
  });
  expect(document.activeElement).toBe(button);
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("combobox", { name: "Model" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Harness options loaded");
  expect(onSettings).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(button);
});

test("discovery errors are announced instead of supplying invented controls", async () => {
  render(
    <HarnessRuntimeSummary
      runtime={harnessRuntimeFromDraft(draft, "/home/user")}
      onDiscover={async () => {
        throw Error("host unavailable");
      }}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Load model and mode options" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "host unavailable",
  );
  expect(screen.queryByRole("combobox")).toBeNull();
});

test("arguments remain structured and unknown runtimes do not display Codex controls", () => {
  const runtime = harnessRuntimeFromDraft(draft, "/home/user");
  expect(runtime.profile.args).toEqual(["--flag", "value with spaces"]);
  expect(() =>
    harnessRuntimeFromDraft({ ...draft, executable: "pi" }, "/home/user"),
  ).toThrow("absolute");
  const { rerender } = render(<HarnessRuntimeSummary runtime={runtime} />);
  expect(screen.getByText("ACP: Pi · Full project access")).toBeTruthy();
  rerender(<HarnessRuntimeSummary runtime={{ version: 200 }} />);
  expect(screen.getByRole("alert").textContent).toMatch("Invalid ACP");
});
