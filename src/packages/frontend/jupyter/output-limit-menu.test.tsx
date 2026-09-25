import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Menu } from "antd";
import { outputLimitMenu } from "./output-limit-menu";

beforeEach(() => {
  // jsdom has no layout; rc-menu excludes zero-size elements from keyboard focus.
  jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    top: 0,
    left: 0,
    right: 100,
    bottom: 20,
    toJSON: () => ({}),
  });
});
afterEach(() => jest.restoreAllMocks());

async function setup(readOnly = false) {
  const actions = {
    get_output_limit_bytes: () => 1024 * 1024,
    set_output_limit_bytes: jest.fn(),
  };
  const items = outputLimitMenu(actions).map(({ name, disabled, ...item }) => ({
    ...item,
    key: name,
    disabled: disabled({ readOnly }),
  }));
  await act(async () => {
    render(<Menu items={items} />);
  });
  return actions;
}

it("names the selected limit and allows keyboard selection", async () => {
  const actions = await setup();
  const first = screen.getByRole("menuitem", {
    name: "1 MiB (default) (selected)",
  });
  const second = screen.getByRole("menuitem", { name: "4 MiB" });
  await act(async () => {
    first.focus();
  });
  fireEvent.keyDown(first, {
    key: "ArrowDown",
    code: "ArrowDown",
    keyCode: 40,
    which: 40,
  });
  await waitFor(() => expect(document.activeElement).toBe(second));
  fireEvent.keyDown(second, {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
  });
  expect(actions.set_output_limit_bytes).toHaveBeenCalledWith(4 * 1024 * 1024);
});

it("does not change the limit in a read-only notebook", async () => {
  const actions = await setup(true);
  const item = screen.getByRole("menuitem", { name: "16 MiB" });
  expect(item.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(item);
  expect(actions.set_output_limit_bytes).not.toHaveBeenCalled();
});
