import { useState } from "react";
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { refreshNamedAgents, useNamedAgents } from "./api";
import { AgentDirectoryContent } from "./directory-content";

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

function DraftForm() {
  const [draft, setDraft] = useState("");
  return (
    <textarea
      aria-label="First request"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
    />
  );
}

function DirectoryWithDraft() {
  const { directory, error, loading } = useNamedAgents();
  if (loading && !directory) return <div role="status">Loading agents</div>;
  return (
    <AgentDirectoryContent hasDirectory={directory != null} error={error}>
      <DraftForm />
    </AgentDirectoryContent>
  );
}

test("retains the mounted draft through a failed refresh and keyboard retry", async () => {
  const user = userEvent.setup();
  mockAccountId = "account";
  const directory = { agents: [] };
  mockList.mockResolvedValueOnce(directory);
  render(<DirectoryWithDraft />);
  const draft = await screen.findByRole("textbox", { name: "First request" });
  await user.type(draft, "Keep this unsent task");
  mockList.mockRejectedValueOnce(new Error("offline"));
  act(() => refreshNamedAgents());
  expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  expect(screen.getByRole("textbox", { name: "First request" })).toBe(draft);
  expect(draft).toHaveValue("Keep this unsent task");
  expect(draft).toHaveFocus();

  let resolve!: (value: any) => void;
  mockList.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const retry = screen.getByRole("button", { name: "Retry directory" });
  retry.focus();
  await user.keyboard("{Enter}");
  expect(mockList).toHaveBeenCalledTimes(3);
  expect(screen.getByRole("textbox", { name: "First request" })).toBe(draft);
  expect(draft).toHaveValue("Keep this unsent task");
  await act(async () => resolve(directory));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("textbox", { name: "First request" })).toBe(draft);
  expect(draft).toHaveValue("Keep this unsent task");
});

test("initial failure shows an error, not a new-agent form, until retry succeeds", async () => {
  const user = userEvent.setup();
  mockAccountId = "account";
  mockList.mockRejectedValueOnce(new Error("offline"));
  render(<DirectoryWithDraft />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading agents");
  await screen.findByRole("alert");
  expect(screen.queryByRole("textbox")).toBeNull();
  mockList.mockResolvedValueOnce({ agents: [] });
  await user.click(screen.getByRole("button", { name: "Retry directory" }));
  expect(
    await screen.findByRole("textbox", { name: "First request" }),
  ).toHaveValue("");
});

test("a failed load for a different account cannot retain the previous directory", async () => {
  mockAccountId = "first";
  mockList.mockResolvedValueOnce({ agents: [{ name: "first-agent" }] });
  const { result, rerender } = renderHook(() => useNamedAgents());
  await waitFor(() => expect(result.current.directory).toBeDefined());
  mockAccountId = "second";
  mockList.mockRejectedValueOnce(new Error("offline"));
  rerender();
  expect(result.current.directory).toBeUndefined();
  await waitFor(() => expect(result.current.error).toContain("offline"));
  expect(result.current.directory).toBeUndefined();
});
