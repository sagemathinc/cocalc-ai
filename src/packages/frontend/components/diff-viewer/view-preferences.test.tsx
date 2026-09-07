import { act, fireEvent, render, screen } from "@testing-library/react";
import { ChangedFilesLayout } from "./changed-files-layout";
import userEvent from "@testing-library/user-event";
import {
  readDiffViewPreferences,
  setDiffViewPreference,
  useDiffViewPreferences,
} from "./view-preferences";

jest.mock("./changed-files-tree", () => ({
  __esModule: true,
  default: () => <div>Tree</div>,
}));

function Probe({ name }: { name: string }) {
  const value = useDiffViewPreferences();
  return (
    <section aria-label={name}>
      <label>
        {name} split
        <input
          type="checkbox"
          checked={value.split}
          onChange={(event) =>
            setDiffViewPreference("split", event.target.checked)
          }
        />
      </label>
      <label>
        {name} wrap
        <input
          type="checkbox"
          checked={value.wrap}
          onChange={(event) =>
            setDiffViewPreference("wrap", event.target.checked)
          }
        />
      </label>
      <textarea aria-label={`${name} draft`} defaultValue="retained draft" />
    </section>
  );
}

beforeEach(() => {
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
});

test("malformed or unknown values fall back independently", () => {
  expect(readDiffViewPreferences("broken")).toEqual({
    split: false,
    wrap: true,
    treeVisible: true,
    treeWidth: 260,
  });
  expect(readDiffViewPreferences('{"split":true,"wrap":"no"}')).toEqual({
    split: true,
    wrap: true,
    treeVisible: true,
    treeWidth: 260,
  });
  expect(readDiffViewPreferences('{"treeWidth":900}').treeWidth).toBe(400);
  expect(readDiffViewPreferences('{"treeWidth":0}').treeWidth).toBe(180);
});

test("keyboard preferences synchronize surfaces and survive reopening without replacing editors", async () => {
  const user = userEvent.setup();
  const view = render(
    <>
      <Probe name="commit" />
      <Probe name="comparison" />
    </>,
  );
  const editor = screen.getByRole("textbox", { name: "comparison draft" });
  screen.getByRole("checkbox", { name: "commit split" }).focus();
  await user.keyboard(" ");
  expect(
    screen.getByRole("checkbox", { name: "comparison split" }),
  ).toBeChecked();
  expect(screen.getByRole("textbox", { name: "comparison draft" })).toBe(
    editor,
  );
  await user.click(screen.getByRole("checkbox", { name: "comparison wrap" }));
  view.unmount();
  render(<Probe name="reopened" />);
  expect(
    screen.getByRole("checkbox", { name: "reopened split" }),
  ).toBeChecked();
  expect(
    screen.getByRole("checkbox", { name: "reopened wrap" }),
  ).not.toBeChecked();
});

test("storage changes from another tab update mounted surfaces", () => {
  render(<Probe name="commit" />);
  act(() => {
    localStorage.setItem(
      "cocalc:diff-view-preferences:v1",
      '{"split":true,"wrap":false}',
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: "cocalc:diff-view-preferences:v1" }),
    );
  });
  expect(screen.getByRole("checkbox", { name: "commit split" })).toBeChecked();
  expect(
    screen.getByRole("checkbox", { name: "commit wrap" }),
  ).not.toBeChecked();
});

test("quota failures do not make view controls stop responding", async () => {
  const user = userEvent.setup();
  render(<Probe name="commit" />);
  const write = jest
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw Error("quota");
    });
  await user.click(screen.getByRole("checkbox", { name: "commit split" }));
  expect(screen.getByRole("checkbox", { name: "commit split" })).toBeChecked();
  write.mockRestore();
});

test("tree visibility and width persist while the diff child stays mounted", async () => {
  const user = userEvent.setup();
  const node = (
    <ChangedFilesLayout files={[]} onSelect={() => {}}>
      <textarea aria-label="Retained editor" />
    </ChangedFilesLayout>
  );
  const first = render(node);
  const editor = screen.getByRole("textbox", { name: "Retained editor" });
  await user.type(editor, "keep this");
  fireEvent.change(screen.getByRole("slider", { name: "File tree width" }), {
    target: { value: "400" },
  });
  screen.getByRole("button", { name: "Hide file tree" }).focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("textbox", { name: "Retained editor" })).toBe(editor);
  expect(editor).toHaveValue("keep this");
  first.unmount();
  render(node);
  await user.click(screen.getByRole("button", { name: "Show file tree" }));
  expect(screen.getByRole("slider", { name: "File tree width" })).toHaveValue(
    "400",
  );
});
