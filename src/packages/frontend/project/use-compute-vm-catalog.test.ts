import { act, renderHook } from "@testing-library/react";
import { useComputeVmCatalog } from "./use-compute-vm-catalog";
import { VM_PREVIEW_CATALOG } from "./compute-vms-preview";

const mockGetCatalog = jest.fn();
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: { hub: { compute: { getCatalog: () => mockGetCatalog() } } },
  },
}));
beforeEach(() => mockGetCatalog.mockReset());

it("stays loading for a slow first request and publishes the catalog on completion", async () => {
  let finish!: (value: unknown) => void;
  mockGetCatalog.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { result } = renderHook(() => useComputeVmCatalog());
  let loaded!: Promise<void>;
  act(() => {
    loaded = result.current.loadCatalog();
  });
  expect(result.current.catalogLoading).toBe(true);
  expect(result.current.catalog).toBeUndefined();
  await act(async () => {
    finish(VM_PREVIEW_CATALOG);
    await loaded;
  });
  expect(result.current.catalogLoading).toBe(false);
  expect(result.current.catalog).toBe(VM_PREVIEW_CATALOG);
});

it("supports failure, retry, and retaining a cached catalog after refresh failure", async () => {
  mockGetCatalog
    .mockRejectedValueOnce(new Error("network unavailable"))
    .mockResolvedValueOnce(VM_PREVIEW_CATALOG)
    .mockRejectedValueOnce(new Error("timeout"));
  const { result } = renderHook(() => useComputeVmCatalog());
  await act(async () => {
    await result.current.loadCatalog();
  });
  expect(result.current.catalogLoading).toBe(false);
  expect(result.current.catalog).toBeUndefined();
  await act(async () => {
    await result.current.loadCatalog();
  });
  expect(result.current.catalogError).toBe(false);
  expect(result.current.catalog).toBe(VM_PREVIEW_CATALOG);
  await act(async () => {
    await result.current.loadCatalog();
  });
  expect(result.current.catalogLoading).toBe(false);
  expect(result.current.catalogError).toBe(true);
  expect(result.current.catalog).toBe(VM_PREVIEW_CATALOG);
});

it("does not let an older completion replace a newer request", async () => {
  let finish!: (value: unknown) => void;
  mockGetCatalog
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValueOnce(VM_PREVIEW_CATALOG);
  const { result } = renderHook(() => useComputeVmCatalog());
  let old!: Promise<void>;
  act(() => {
    old = result.current.loadCatalog();
  });
  await act(async () => {
    await result.current.loadCatalog();
  });
  await act(async () => {
    finish({});
    await old;
  });
  expect(result.current.catalog).toBe(VM_PREVIEW_CATALOG);
});
