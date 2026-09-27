import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Map } from "immutable";
import { DirectoryCollection } from "./directory-collection";

let mockSettings = Map();
const mockSave = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (_store, key) =>
    key === "account_id" ? "alice" : mockSettings,
  redux: {
    getStore: () => ({ get: () => "alice" }),
    getActions: () => ({ set_other_settings_and_wait: mockSave }),
  },
}));
beforeEach(() => {
  mockSettings = Map();
  mockSave.mockReset().mockImplementation(async (key, value) => {
    mockSettings = mockSettings.set(key, value);
  });
});
const props = {
  items: ["Bob", "Carol"],
  itemId: (id: string) => id,
  itemTitle: (id: string) => id,
  renderItem: (id: string) => <button>Open {id}</button>,
};

test("People pin, grid and manual order persist, without changing membership", async () => {
  const user = userEvent.setup();
  const mount = () =>
    render(
      <DirectoryCollection {...props} collection="people" label="People" />,
    );
  const view = mount();
  await user.click(screen.getByRole("button", { name: "Pin Carol" }));
  await user.click(screen.getByRole("button", { name: "Pin Bob" }));
  await user.click(screen.getByRole("button", { name: "Grid view" }));
  await user.click(screen.getByRole("button", { name: "Reorder Carol" }));
  await user.click(screen.getByRole("menuitem", { name: "Move down" }));
  await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(4));
  view.unmount();
  mount();
  expect(screen.getByRole("button", { name: "Grid view" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const pins = within(screen.getByRole("region", { name: "Pinned" }));
  expect(
    pins
      .getAllByRole("button", { name: /^Open/ })
      .map((button) => button.textContent),
  ).toEqual(["Open Bob", "Open Carol"]);
});

test.each(["projects", "conversations"] as const)(
  "%s retains its existing pin adapter and handles failed writes",
  async (collection) => {
    const user = userEvent.setup();
    let reject!: (error: Error) => void;
    const onPin = jest.fn(
      () =>
        new Promise<void>((_done, fail) => {
          reject = fail;
        }),
    );
    render(
      <DirectoryCollection
        {...props}
        collection={collection}
        label={collection}
        isPinned={() => false}
        onPin={onPin}
      />,
    );
    const pin = screen.getByRole("button", { name: "Pin Bob" });
    act(() => pin.focus());
    await user.keyboard("{Enter}{Enter}");
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onPin).toHaveBeenCalledWith("Bob", true);
    expect(pin).toHaveAttribute("aria-disabled", "true");
    await act(async () => reject(Error("offline")));
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    expect(pin).toHaveFocus();
    expect(pin).toHaveAttribute("aria-pressed", "false");
    expect(mockSave).not.toHaveBeenCalled();
  },
);
