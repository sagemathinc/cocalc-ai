/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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

test("profile fields have visible labels and support keyboard editing", async () => {
  function Form() {
    const [value, setValue] = useState(draft);
    return <HarnessProfileFields value={value} onChange={setValue} />;
  }
  render(<Form />);
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
