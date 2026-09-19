import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CourseVmTemplateSelect } from "./course-vm-template-select";
import {
  catalog,
  template,
} from "@cocalc/frontend/course/test/course-vm-template-fixture";

jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));
jest.mock("@cocalc/frontend/hosts/hooks/use-host-pricing-settings", () => ({
  useHostPricingSettings: () => ({}),
}));
async function choose(user: ReturnType<typeof userEvent.setup>) {
  await user.tab();
  const select = screen.getByRole("combobox", {
    name: "Recommended VM configuration",
  });
  expect(select).toHaveFocus();
  fireEvent.keyDown(select, { key: "ArrowDown", keyCode: 40, which: 40 });
  await screen.findAllByText("Notebook CPU");
  fireEvent.keyDown(select, { key: "ArrowDown", keyCode: 40, which: 40 });
  fireEvent.keyDown(select, { key: "Enter", keyCode: 13, which: 13 });
}
it("defaults once to the first recommendation and preserves custom edits", async () => {
  const onApply = jest.fn();
  const getCatalog = jest.fn().mockResolvedValue(catalog);
  const props = {
    templates: [template],
    sourceKey: "course",
    defaultToFirst: true,
    onApply,
    getCatalog,
  };
  const view = render(<CourseVmTemplateSelect {...props} />);
  await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
  const select = screen.getByRole("combobox", {
    name: "Recommended VM configuration",
  });
  expect(select.closest(".ant-select")).toHaveTextContent("Notebook CPU");

  act(() => select.focus());
  fireEvent.keyDown(select, { key: "ArrowDown", keyCode: 40, which: 40 });
  fireEvent.keyDown(select, { key: "ArrowUp", keyCode: 38, which: 38 });
  fireEvent.keyDown(select, { key: "Enter", keyCode: 13, which: 13 });
  await waitFor(() =>
    expect(select.closest(".ant-select")).toHaveTextContent(
      "Custom configuration",
    ),
  );
  expect(onApply).toHaveBeenCalledTimes(1);

  view.rerender(<CourseVmTemplateSelect {...props} resetKey={1} />);
  expect(select.closest(".ant-select")).toHaveTextContent(
    "Custom configuration",
  );
  expect(getCatalog).toHaveBeenCalledTimes(1);
});
it("selects by keyboard, fetches a fresh quote and applies hardware only", async () => {
  const user = userEvent.setup();
  const onApply = jest.fn();
  const getCatalog = jest.fn().mockResolvedValue(catalog);
  render(
    <CourseVmTemplateSelect
      templates={[template]}
      sourceKey="course"
      onApply={onApply}
      getCatalog={getCatalog}
    />,
  );
  expect(getCatalog).not.toHaveBeenCalled();
  await choose(user);
  await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
  expect(onApply.mock.calls[0][0]).toMatchObject(template.config);
  expect(onApply.mock.calls[0][0]).not.toHaveProperty("funding_source");
  expect(screen.getByRole("status")).toHaveTextContent("Current estimate:");
  act(() =>
    screen
      .getByRole("combobox", { name: "Recommended VM configuration" })
      .focus(),
  );
  const select = screen.getByRole("combobox", {
    name: "Recommended VM configuration",
  });
  fireEvent.keyDown(select, { key: "ArrowDown", keyCode: 40, which: 40 });
  fireEvent.keyDown(select, { key: "ArrowUp", keyCode: 38, which: 38 });
  fireEvent.keyDown(select, { key: "Enter", keyCode: 13, which: 13 });
  expect(onApply).toHaveBeenCalledTimes(1);
});
it("offers alternatives without changing the draft when the recommended machine disappears", async () => {
  const user = userEvent.setup();
  const onApply = jest.fn();
  render(
    <CourseVmTemplateSelect
      templates={[
        { ...template, config: { ...template.config, machine_type: "gone" } },
      ]}
      sourceKey="course"
      onApply={onApply}
      getCatalog={async () => catalog}
    />,
  );
  await choose(user);
  expect(await screen.findByText(/not currently offered/)).toBeVisible();
  expect(onApply).not.toHaveBeenCalled();
  const alternatives = screen.getByRole("combobox", {
    name: "Currently offered alternatives",
  });
  act(() => alternatives.focus());
  fireEvent.keyDown(alternatives, { key: "ArrowDown", keyCode: 40, which: 40 });
  fireEvent.keyDown(alternatives, { key: "Enter", keyCode: 13, which: 13 });
  await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
});
it("does not apply a delayed quote after switching funding sources", async () => {
  let resolve!: (value: typeof catalog) => void;
  const getCatalog = jest.fn(
    () =>
      new Promise<typeof catalog>((done) => {
        resolve = done;
      }),
  );
  const user = userEvent.setup();
  const onApply = jest.fn();
  const onPendingChange = jest.fn();
  const props = { templates: [template], onApply, getCatalog, onPendingChange };
  const view = render(<CourseVmTemplateSelect {...props} sourceKey="first" />);
  await choose(user);
  expect(onPendingChange).toHaveBeenLastCalledWith(true);
  view.rerender(<CourseVmTemplateSelect {...props} sourceKey="second" />);
  await act(async () => resolve(catalog));
  expect(onApply).not.toHaveBeenCalled();
  expect(onPendingChange).toHaveBeenLastCalledWith(false);
});
it("reports catalog failures without mutating the draft", async () => {
  const user = userEvent.setup();
  const onApply = jest.fn();
  render(
    <CourseVmTemplateSelect
      templates={[template]}
      sourceKey="course"
      onApply={onApply}
      getCatalog={async () => {
        throw new Error("Catalog unavailable");
      }}
    />,
  );
  await choose(user);
  expect(await screen.findByText("Catalog unavailable")).toBeVisible();
  expect(onApply).not.toHaveBeenCalled();
});
