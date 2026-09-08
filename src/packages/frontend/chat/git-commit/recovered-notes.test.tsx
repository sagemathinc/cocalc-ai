import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecoveredNotes } from "./recovered-notes";

test("recovered notes are keyboard-accessible, read-only and preserved when collapsed", async () => {
  const user = userEvent.setup();
  const note =
    "Local ![image](/blobs/note.png)\n<script>not executable</script>";
  render(
    <RecoveredNotes current="Current" versions={["Current", note, note, ""]} />,
  );
  const toggle = screen.getByRole("button", {
    name: "Recovered private note versions (2)",
  });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("textbox")).toBeNull();
  toggle.focus();
  await user.keyboard("{Enter}");
  expect(toggle).toHaveFocus();
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  const alternative = screen.getByRole("textbox", {
    name: "Recovered private note version 1",
  });
  await user.tab();
  expect(alternative).toHaveFocus();
  expect(alternative).toHaveValue(note);
  expect(alternative).toHaveAttribute("readonly");
  await user.keyboard("edited");
  expect(alternative).toHaveValue(note);
  expect(
    screen.getByRole("textbox", { name: "Recovered private note version 2" }),
  ).toHaveValue("");
  toggle.focus();
  await user.keyboard(" ");
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  await user.keyboard("{Enter}");
  expect(alternative).toHaveValue(note);
});

test("ordinary notes do not gain recovery controls", () => {
  const { rerender } = render(<RecoveredNotes current="note" />);
  expect(screen.queryByRole("button")).toBeNull();
  rerender(<RecoveredNotes current="note" versions={["note"]} />);
  expect(screen.queryByRole("button")).toBeNull();
});
