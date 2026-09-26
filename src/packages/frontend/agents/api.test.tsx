import { act, renderHook, waitFor } from "@testing-library/react";
import { refreshNamedAgents, useNamedAgents } from "./api";

let mockAccountId: string | undefined;
const mockList = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (store: string, key: string) =>
    store === "account" && key === "account_id" ? mockAccountId : undefined,
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: { agent: { listNamedAgents: (...args) => mockList(...args) } },
    },
  },
}));

beforeEach(() => {
  mockAccountId = undefined;
  mockList.mockReset();
  refreshNamedAgents();
});

test("keeps the agents page loading while account identity and directory are pending", async () => {
  let resolve!: (value: any) => void;
  mockList.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const { result, rerender } = renderHook(() => useNamedAgents());
  expect(result.current.loading).toBe(true);
  expect(result.current.directory).toBeUndefined();
  expect(mockList).not.toHaveBeenCalled();

  mockAccountId = "account";
  rerender();
  expect(result.current.loading).toBe(true);
  const directory = { agents: [] };
  await act(async () => resolve(directory));
  expect(result.current).toMatchObject({ directory, loading: false });
});

test("does not show a previous account's agents while the next account loads", async () => {
  mockAccountId = "first";
  mockList.mockResolvedValueOnce({ agents: [{ name: "first-agent" }] });
  const { result, rerender } = renderHook(() => useNamedAgents());
  await waitFor(() => expect(result.current.directory).toBeDefined());
  mockAccountId = undefined;
  rerender();
  expect(result.current).toEqual({ loading: true });
  mockList.mockReturnValue(new Promise(() => {}));
  mockAccountId = "second";
  rerender();
  expect(result.current).toEqual({ loading: true });
});

test("finishes loading with an explicit error rather than an empty directory", async () => {
  mockAccountId = "account";
  mockList.mockRejectedValueOnce(new Error("offline"));
  const { result } = renderHook(() => useNamedAgents());
  await waitFor(() => expect(result.current.error).toContain("offline"));
  expect(result.current.loading).toBe(false);
  expect(result.current.directory).toBeUndefined();
});

test("disabled directory readers do not wait for authentication", () => {
  const { result } = renderHook(() => useNamedAgents(false));
  expect(result.current).toEqual({ loading: false });
  expect(mockList).not.toHaveBeenCalled();
});
