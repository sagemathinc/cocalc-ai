import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentsSidebarResizeHandle } from "./sidebar-resize-handle";

test("sidebar resize handle supports keyboard and bounded sizes", async () => {
  const user = userEvent.setup();
  const onResize = jest.fn();
  render(
    <AgentsSidebarResizeHandle
      width={300}
      minWidth={240}
      maxWidth={500}
      onResize={onResize}
    />,
  );
  const handle = screen.getByRole("separator", { name: "Resize Agents panel" });
  await user.tab();
  expect(document.activeElement).toBe(handle);
  await user.keyboard("{ArrowRight}");
  expect(onResize).toHaveBeenLastCalledWith(320);
  await user.keyboard("{ArrowLeft}");
  expect(onResize).toHaveBeenLastCalledWith(280);
  await user.keyboard("{Home}");
  expect(onResize).toHaveBeenLastCalledWith(240);
  await user.keyboard("{End}");
  expect(onResize).toHaveBeenLastCalledWith(500);
});
