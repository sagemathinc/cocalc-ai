import { render, screen } from "@testing-library/react";
import { GitReviewTitle } from "./review-title";

test("shows only the commit subject and clears it when the selection is loading", () => {
  const view = render(
    <GitReviewTitle subject={"Fix worktree review\n\nDetails"} />,
  );
  expect(screen.getByText("Git review")).toBeVisible();
  expect(screen.getByTitle("Fix worktree review").tagName).toBe("STRONG");
  expect(screen.queryByText("Details")).not.toBeInTheDocument();
  view.rerender(<GitReviewTitle />);
  expect(screen.queryByText("Fix worktree review")).not.toBeInTheDocument();
  view.rerender(<GitReviewTitle subject="Uncommitted changes" />);
  expect(screen.getByTitle("Uncommitted changes")).toBeVisible();
});
