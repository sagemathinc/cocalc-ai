import { act, renderHook, waitFor } from "@testing-library/react";
const getUsername = jest.fn();
const client = { hub: { personalUrls: { getUsername } } };
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { conat_client: client },
}));
import {
  usePersonalUrlOwner,
  refreshPersonalUrlOwner,
} from "./personal-url-owner";
import { dispatchUsernameChanged } from "@cocalc/frontend/account/username-events";

beforeEach(() => getUsername.mockReset());

test("UUID fallback is qualified; username saves refresh mounted link labels", async () => {
  const account = "11111111-1111-4111-8111-111111111111";
  getUsername.mockResolvedValue({ account_id: account, username: "alice" });
  const hook = renderHook(() => usePersonalUrlOwner(account));
  expect(hook.result.current).toBe(account);
  await waitFor(() => expect(hook.result.current).toBe("alice"));
  getUsername.mockResolvedValue({ account_id: account, username: "alice-new" });
  act(() =>
    dispatchUsernameChanged({ account_id: account, username: "alice-new" }),
  );
  await waitFor(() => expect(hook.result.current).toBe("alice-new"));
  getUsername.mockResolvedValue({ account_id: account, username: null });
  act(() => refreshPersonalUrlOwner(account));
  await waitFor(() => expect(hook.result.current).toBe(account));
  expect(getUsername).toHaveBeenLastCalledWith({ owner_account_id: account });
});

test("a late username reply cannot cross account or refresh generations", async () => {
  let finish!: (value: unknown) => void;
  getUsername.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const hook = renderHook(({ account }) => usePersonalUrlOwner(account), {
    initialProps: { account: "alice" },
  });
  getUsername.mockResolvedValue({ account_id: "bob", username: "bob-current" });
  hook.rerender({ account: "bob" });
  expect(hook.result.current).toBe("bob");
  await waitFor(() => expect(hook.result.current).toBe("bob-current"));
  await act(async () => finish({ account_id: "alice", username: "alice-old" }));
  expect(hook.result.current).toBe("bob-current");
});
