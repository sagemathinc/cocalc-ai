/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { fromJS } from "immutable";
import { Find } from "./find";

const mockEraseActiveKeyHandler = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  useEffect: require("react").useEffect,
  useRef: require("react").useRef,
  redux: {
    getActions: (name: string) =>
      name === "page"
        ? { erase_active_key_handler: mockEraseActiveKeyHandler }
        : undefined,
  },
}));

jest.mock("antd", () => {
  const Search = ({
    value,
    onChange,
    allowClear,
    ...props
  }: Record<string, any>) => (
    <input
      data-testid="task-filter-input"
      value={value ?? ""}
      onChange={(event) => onChange?.(event)}
      {...props}
    />
  );
  return { Input: { Search } };
});

jest.mock("./empty-trash", () => ({
  EmptyTrash: () => <div>empty-trash</div>,
}));

jest.mock("./show-toggle", () => ({
  ShowToggle: () => <div>show-toggle</div>,
}));

describe("task filter keyboard boundary", () => {
  beforeEach(() => {
    mockEraseActiveKeyHandler.mockClear();
  });

  it("clears page shortcuts when the filter input is focused", () => {
    render(
      <Find
        actions={
          {
            set_local_view_state: jest.fn(),
            blur_find_box: jest.fn(),
            disable_key_handler: jest.fn(),
            enable_key_handler: jest.fn(),
          } as any
        }
        local_view_state={fromJS({ search: "" }) as any}
      />,
    );

    expect(
      document.querySelector('[data-cocalc-keyboard-boundary="task-search"]'),
    ).toBeTruthy();

    fireEvent.focus(screen.getByTestId("task-filter-input"));

    expect(mockEraseActiveKeyHandler).toHaveBeenCalledTimes(1);
  });
});
