/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { Complete } from "./complete";

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
