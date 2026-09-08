import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewAliasChoice } from "./review-alias-choice";
import type { GitReviewAliasConflict } from "../git-review-store";

const conflict = {
  inspection: {
    full: "a".repeat(40),
    snapshots: {},
    records: [
      {
        commit_sha: "aaaaaaa",
        note: "preserved note",
        reviewed: false,
        comments: {},
      },
      {
        commit_sha: "a".repeat(40),
        note: "other note",
        reviewed: true,
        comments: {},
      },
    ],
  },
} as GitReviewAliasConflict;

test("requires an explicit choice and supports keyboard activation without deleting alternatives", async () => {
  const user = userEvent.setup();
  const onChoose = jest.fn().mockResolvedValue(undefined);
  render(
    <ReviewAliasChoice
      conflict={conflict}
      onChoose={onChoose}
      onReload={jest.fn()}
    />,
  );
  const useSelected = screen.getByRole("button", {
    name: "Use selected review",
  });
  expect(useSelected).toBeDisabled();
  const radio = screen.getByRole("radio", { name: "Use review aaaaaaa" });
  radio.focus();
  await user.keyboard(" ");
  expect(radio).toBeChecked();
  useSelected.focus();
  await user.keyboard("{Enter}");
  expect(onChoose).toHaveBeenCalledWith("aaaaaaa");
  expect(screen.getAllByRole("radio")).toHaveLength(2);
  expect(useSelected).toHaveFocus();
});

test("reports stale-choice failures and exposes reload", async () => {
  const user = userEvent.setup();
  const reload = jest.fn();
  render(
    <ReviewAliasChoice
      conflict={conflict}
      onChoose={async () => {
        throw Error("Records changed");
      }}
      onReload={reload}
    />,
  );
  await user.click(screen.getByRole("radio", { name: "Use review aaaaaaa" }));
  await user.click(screen.getByRole("button", { name: "Use selected review" }));
  expect(await screen.findByText("Error: Records changed")).toHaveAttribute(
    "role",
    "alert",
  );
  screen.getByRole("button", { name: "Reload reviews" }).focus();
  await user.keyboard("{Enter}");
  expect(reload).toHaveBeenCalled();
});
