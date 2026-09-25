/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThreadPanelToolbar } from "../thread-panel-toolbar";

test("portaled controls remain keyboard accessible when inline controls are hidden", async () => {
  const user = userEvent.setup();
  const portal = document.createElement("div");
  document.body.appendChild(portal);
  const search = jest.fn();
  const view = render(
    <ThreadPanelToolbar
      showInline={false}
      portal={portal}
      render={() => <button onClick={search}>Search thread</button>}
    />,
  );
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Search thread" }),
  );
  await user.keyboard("{Enter}");
  expect(search).toHaveBeenCalledTimes(1);
  expect(portal.contains(document.activeElement)).toBe(true);
  view.unmount();
  portal.remove();
});

test.each([false, true])(
  "a pending portal does not leak controls inline (%s)",
  (showInline) => {
    render(
      <ThreadPanelToolbar
        showInline={showInline}
        portal={null}
        render={() => <button>Search thread</button>}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  },
);

test("without a portal the inline visibility flag still applies", () => {
  const content = () => <button>Search thread</button>;
  const view = render(
    <ThreadPanelToolbar showInline={false} render={content} />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  view.rerender(<ThreadPanelToolbar showInline render={content} />);
  expect(screen.getByRole("button", { name: "Search thread" })).toBeTruthy();
});
