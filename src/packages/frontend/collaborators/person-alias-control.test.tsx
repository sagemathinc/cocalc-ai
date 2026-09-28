import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
jest.mock("./workspace-api", () => ({ boundCollaboratorsApi: jest.fn() }));
import { PersonAliasControl } from "./person-alias-control";

test("keyboard users can set, rename, and clear a private person alias", async () => {
  const user = userEvent.setup();
  const api = {
    getPersonAlias: jest.fn(async () => ({ alias: null })),
    setPersonAlias: jest.fn(async ({ alias }) => ({ alias: alias || null })),
  };
  const onChange = jest.fn();
  const onResolve = jest.fn();
  render(
    <PersonAliasControl
      accountId="me"
      personId="person"
      api={api}
      onChange={onChange}
      onResolve={onResolve}
    />,
  );
  const input = screen.getByRole("textbox", { name: "Private person alias" });
  await waitFor(() => expect(input).toBeEnabled());
  expect(onResolve).toHaveBeenCalledWith(null);
  input.focus();
  await user.keyboard("Alice{Tab}{Enter}");
  await screen.findByText("/people/alice");
  expect(onChange).toHaveBeenLastCalledWith("alice");
  expect(api.setPersonAlias).toHaveBeenLastCalledWith({
    person_id: "person",
    alias: "alice",
  });
  await user.click(input);
  await user.clear(input);
  await user.keyboard("Bob{Enter}");
  await screen.findByText("/people/bob");
  await user.clear(input);
  input.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(null));
  expect(input).toHaveFocus();
  expect(screen.getByRole("status")).toHaveTextContent("Private alias saved.");
});
test("errors are announced and person/account switches discard pending replies", async () => {
  let finish!: (value: { alias: string | null }) => void;
  const api = {
    getPersonAlias: jest.fn(
      () =>
        new Promise<{ alias: string | null }>((resolve) => {
          finish = resolve;
        }),
    ),
    setPersonAlias: jest.fn(async () => {
      throw Error("Alias in use");
    }),
  };
  const view = render(
    <PersonAliasControl accountId="first" personId="one" api={api} />,
  );
  const old = finish;
  view.rerender(
    <PersonAliasControl accountId="second" personId="two" api={api} />,
  );
  await act(async () => old({ alias: "private-first" }));
  expect(screen.getByRole("textbox")).toHaveValue("");
  await act(async () => finish({ alias: null }));
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox"), "alice{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("Alias in use");
  expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
});
