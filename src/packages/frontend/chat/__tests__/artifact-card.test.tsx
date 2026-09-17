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
  await user.keyboard(" ");
  expect(open).toHaveBeenCalledTimes(2);
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

test("compact attachment bounds its width and keeps metadata on one line", () => {
  render(
    <ArtifactCard
      publication={
        {
          snapshot: {
            title: "A very long file title ".repeat(20),
            markdown: "A description that belongs in the workbench.",
            file: { path: "/repo/" + "long-directory/".repeat(20) + "plan.md" },
          },
        } as any
      }
      open={jest.fn()}
    />,
  );
  expect(screen.getByRole("article")).toHaveStyle({
    width: "fit-content",
    maxWidth: "min(520px, 100%)",
  });
  const open = screen.getByRole("button", { name: /Open artifact:/ });
  expect(open).toHaveStyle({
    position: "absolute",
    width: "100%",
    height: "100%",
  });
  expect(screen.getByText(/\/repo\//).parentElement).toHaveStyle({
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  });
  expect(
    screen.queryByText("A description that belongs in the workbench."),
  ).toBeNull();
});
