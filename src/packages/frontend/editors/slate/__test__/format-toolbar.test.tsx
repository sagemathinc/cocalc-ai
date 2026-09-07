/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarksBar } from "../edit-bar/marks-bar";
import { formatAction } from "../format";

jest.mock("../format", () => ({ formatAction: jest.fn() }));

it("names formatting controls and exposes the active mark to keyboard users", async () => {
  const user = userEvent.setup();
  const editor = {} as any;
  render(<MarksBar editor={editor} marks={{ bold: true }} />);
  const bold = screen.getByRole("button", { name: /^Bold/ });
  expect(bold.getAttribute("aria-pressed")).toBe("true");
  expect(
    screen
      .getByRole("button", { name: /^Italics/ })
      .getAttribute("aria-pressed"),
  ).toBe("false");
  bold.focus();
  await user.keyboard("{Enter}");
  expect(formatAction).toHaveBeenCalledWith(editor, "bold", []);
  expect(screen.getByRole("button", { name: "Insert link" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Create executable code block" }),
  ).toBeTruthy();
});

it("opens the existing upload picker from the Insert menu", async () => {
  const user = userEvent.setup();
  const openFilePicker = jest.fn();
  render(<MarksBar editor={{ openFilePicker } as any} marks={{}} />);
  const insert = screen.getByRole("button", { name: "Insert", exact: true });
  insert.focus();
  await user.keyboard("{Enter}");
  await user.click(
    await screen.findByRole("menuitem", { name: "Upload files..." }),
  );
  expect(openFilePicker).toHaveBeenCalledTimes(1);
});
