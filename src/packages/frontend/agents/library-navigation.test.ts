import { openLibrary } from "./library-navigation";
import { set_url } from "@cocalc/frontend/history";
const setState = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ setState }) },
}));
jest.mock("@cocalc/frontend/history", () => ({ set_url: jest.fn() }));

test("Library navigation changes only Library state, not the selected agent", () => {
  openLibrary();
  expect(setState).toHaveBeenLastCalledWith({
    library_open: true,
    library_project_id: undefined,
    library_entry_id: undefined,
  });
  expect(set_url).toHaveBeenLastCalledWith("/library", "");
  openLibrary("11111111-1111-4111-8111-111111111111", "a".repeat(64));
  expect(set_url).toHaveBeenLastCalledWith(
    `/library/11111111-1111-4111-8111-111111111111/${"a".repeat(64)}`,
    "",
  );
  expect(
    setState.mock.calls.every(([change]) => !("active_agent_id" in change)),
  ).toBe(true);
});
