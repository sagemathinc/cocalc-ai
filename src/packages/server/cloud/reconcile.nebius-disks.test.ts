const mockList = jest.fn();
const mockDispose = jest.fn(async () => {});

jest.mock("@cocalc/cloud/nebius/client", () => ({
  NebiusClient: jest.fn().mockImplementation(() => ({
    disks: { list: mockList },
    [Symbol.asyncDispose]: mockDispose,
  })),
}));

import { dataDiskStatus } from "./reconcile";

const host = {
  id: "host-test",
  metadata: { runtime: { metadata: { diskIds: { data: "disk-target" } } } },
};
const creds = { parentId: "parent-test" };

beforeEach(() => {
  mockList.mockReset();
  mockDispose.mockClear();
});

it("uses the allowed page size and finds a disk on a later page", async () => {
  mockList.mockImplementation(async ({ pageSize, pageToken }) => {
    if (pageSize > 999) throw Error("page_size is invalid");
    return pageToken === "next-page"
      ? { items: [{ metadata: { id: "disk-target" } }] }
      : {
          items: [{ metadata: { id: "other-disk" } }],
          nextPageToken: "next-page",
        };
  });
  await expect(dataDiskStatus("nebius", host, creds)).resolves.toBe("present");
  expect(mockList.mock.calls).toEqual([
    [{ parentId: "parent-test", pageSize: 999, pageToken: "" }],
    [{ parentId: "parent-test", pageSize: 999, pageToken: "next-page" }],
  ]);
  expect(mockDispose).toHaveBeenCalledTimes(1);
});

it("returns missing only after exhausting successful pages", async () => {
  mockList
    .mockResolvedValueOnce({ items: [], nextPageToken: "next-page" })
    .mockResolvedValueOnce({ items: [] });
  await expect(dataDiskStatus("nebius", host, creds)).resolves.toBe("missing");
  expect(mockList).toHaveBeenCalledTimes(2);
  expect(mockDispose).toHaveBeenCalledTimes(1);
});

it("returns unknown, not missing, when a later page fails", async () => {
  mockList
    .mockResolvedValueOnce({ items: [], nextPageToken: "next-page" })
    .mockRejectedValueOnce(Error("provider unavailable"));
  await expect(dataDiskStatus("nebius", host, creds)).resolves.toBe("unknown");
  expect(mockDispose).toHaveBeenCalledTimes(1);
});
