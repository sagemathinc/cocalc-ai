/** @jest-environment jsdom */

import Tabs from "@rc-component/tabs";
import { act, fireEvent, render, screen } from "@testing-library/react";

describe("Ant Design tabs with filename keys", () => {
  it.each([
    "/home/user/Exercise_1\nmkdir Exercise_1/terminal.term",
    "carriage\rreturn.term",
    "form\ffeed.term",
    "back\\slash.term",
    'double"quote.term',
    "bracket]and space.term",
  ])("measures and selects a tab without changing its key: %p", (key) => {
    const onChange = jest.fn();
    const queries: { selector: string; node: Element | null }[] = [];
    const original = Element.prototype.querySelector;
    const spy = jest
      .spyOn(Element.prototype, "querySelector")
      .mockImplementation(function (this: Element, selector: string) {
        const node = original.call(this, selector);
        if (selector.startsWith("[data-node-key=")) {
          queries.push({ selector, node });
        }
        return node;
      });
    try {
      render(
        <Tabs
          defaultActiveKey="ordinary"
          onChange={onChange}
          items={[
            { key: "ordinary", label: "Ordinary file" },
            { key, label: "Unusual filename" },
          ]}
        />,
      );
      expect(queries.length).toBeGreaterThan(0);
      expect(queries.every(({ node }) => node != null)).toBe(true);
      const tab = screen.getByRole("tab", { name: "Unusual filename" });
      act(() => tab.focus());
      expect(tab).toHaveFocus();
      fireEvent.keyDown(tab, { key: "Enter", code: "Enter", keyCode: 13 });
      expect(onChange).toHaveBeenCalledWith(key);
      expect(tab).toHaveAttribute("aria-selected", "true");
    } finally {
      spy.mockRestore();
    }
  });
});
