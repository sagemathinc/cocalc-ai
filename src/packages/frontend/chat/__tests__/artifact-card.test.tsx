import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArtifactCard } from "../artifact-card";
test("card title and history are keyboard accessible without triggering the surrounding message", async () => {
  const user = userEvent.setup();
  const open = jest.fn();
  const parent = jest.fn();
  const publication = {
    operation_id: "version",
    snapshot: {
      title: "Fix parser",
      markdown: "Keeps the parser correct.",
      commit: {
        sha: "a".repeat(40),
        path: "/repo",
        common_directory: "/repo/.git",
        branch: "fix",
      },
    },
  } as any;
  render(
    <div onClick={parent}>
      <ArtifactCard publication={publication} open={open} />
    </div>,
  );
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Open artifact: Fix parser" }),
  );
  await user.keyboard("{Enter}");
  expect(open).toHaveBeenCalledWith();
  expect(parent).not.toHaveBeenCalled();
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "More options for Fix parser" }),
  );
  await user.keyboard("{Enter}");
  const item = await screen.findByRole("menuitem", {
    name: "Published version",
  });
  item.focus();
  // rc-menu still reads keyCode; jsdom user-event does not supply it.
  fireEvent.keyDown(item, {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
  });
  await waitFor(() => expect(open).toHaveBeenCalledWith("version"));
  expect(parent).not.toHaveBeenCalled();
});
