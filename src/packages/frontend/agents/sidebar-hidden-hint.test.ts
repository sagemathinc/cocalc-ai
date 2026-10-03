import { message } from "antd";
import { explainHiddenSidebarOnce } from "./sidebar-hidden-hint";

test("explains how to show a hidden sidebar, once", () => {
  localStorage.clear();
  const info = jest
    .spyOn(message, "info")
    .mockImplementation(() => ({}) as any);
  explainHiddenSidebarOnce();
  explainHiddenSidebarOnce();
  expect(info).toHaveBeenCalledTimes(1);
  expect(info.mock.calls[0][0]).toMatchObject({
    content: expect.stringContaining("CoCalc logo at the top left"),
  });
});
