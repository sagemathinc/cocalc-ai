/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { Complete } from "./complete";
import $ from "jquery";

it("expands the directory with Enter without inserting an action as a mention", async () => {
  const onSelect = jest.fn();
  const expand = jest.fn();
  const props = { onSelect, onCancel: jest.fn(), offset: { left: 0, top: 0 } };
  const { rerender } = render(
    <Complete
      {...props}
      items={[
        { value: "browse", label: "Search all agents", onSelect: expand },
      ]}
    />,
  );
  await screen.findByRole("menuitem", { name: "Search all agents" });
  fireEvent.keyDown(document, { key: "Enter", keyCode: 13 });
  expect(expand).toHaveBeenCalledTimes(1);
  expect(onSelect).not.toHaveBeenCalled();
  rerender(
    <Complete {...props} items={[{ value: "agent", label: "Agent" }]} />,
  );
  fireEvent.keyDown(document, { key: "Enter", keyCode: 13 });
  expect(onSelect).toHaveBeenCalledWith("agent");
});

it("keyboard selection skips disabled async status and follows rendered group order", async () => {
  ($.fn as any).scrollintoview = jest.fn();
  const onSelect = jest.fn();
  const onCancel = jest.fn();
  const props = { onSelect, onCancel, offset: { left: 0, top: 0 } };
  const { rerender } = render(
    <Complete
      {...props}
      items={[
        {
          value: "loading",
          disabled: true,
          label: <span role="status">Searching references</span>,
        },
      ]}
    />,
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Searching references",
  );
  fireEvent.keyDown(document, { key: "Enter", keyCode: 13 });
  expect(onSelect).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
  rerender(
    <Complete
      {...props}
      items={[
        { value: "a1", label: "First artifact", group: "Artifacts" },
        { value: "agent", label: "Agent", group: "Agents" },
        { value: "a2", label: "Second artifact", group: "Artifacts" },
        {
          value: "coverage",
          disabled: true,
          label: "Indexing",
          group: "References",
        },
      ]}
    />,
  );
  await screen.findByRole("menuitem", { name: "First artifact" });
  fireEvent.keyDown(document, { key: "ArrowDown", keyCode: 40 });
  fireEvent.keyDown(document, { key: "Enter", keyCode: 13 });
  expect(onSelect).toHaveBeenLastCalledWith("a2");
  fireEvent.keyDown(document, { key: "Escape", keyCode: 27 });
  expect(onCancel).toHaveBeenCalledTimes(1);
});
