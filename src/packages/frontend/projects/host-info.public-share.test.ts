import { fromJS } from "immutable";
import { isPublicDirectoryShareHost } from "./host-info";

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getStore: () => undefined },
  useTypedRedux: () => undefined,
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));

test("finds public directory share hosts once per project map version", () => {
  const projectMap = fromJS({
    a: { host_id: "host-1", public_directory_share_projection: true },
    b: { host_id: "host-2" },
  }) as any;
  const forEach = jest.spyOn(projectMap, "forEach");
  expect(isPublicDirectoryShareHost("host-1", projectMap)).toBe(true);
  expect(isPublicDirectoryShareHost("host-2", projectMap)).toBe(false);
  expect(isPublicDirectoryShareHost("host-3", projectMap)).toBe(false);
  expect(forEach).toHaveBeenCalledTimes(1);
  const next = projectMap.setIn(
    ["b", "public_directory_share_projection"],
    true,
  );
  expect(isPublicDirectoryShareHost("host-2", next)).toBe(true);
});
