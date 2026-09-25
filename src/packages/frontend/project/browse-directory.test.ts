import { browseProjectDirectory } from "./browse-directory";
const open = jest.fn();
const select = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getProjectActions: () => ({ open_directory: open }),
    getActions: () => ({ set_active_tab: select }),
  },
}));
test("opens the requested folder then brings its project forward", async () => {
  open.mockImplementation(async () => expect(select).not.toHaveBeenCalled());
  await browseProjectDirectory("project", "/home/user/data");
  expect(open).toHaveBeenCalledWith("/home/user/data");
  expect(select).toHaveBeenCalledWith("project");
});
