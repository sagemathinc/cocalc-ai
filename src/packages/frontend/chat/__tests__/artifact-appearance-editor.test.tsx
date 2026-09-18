import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import Editor from "../artifact-appearance-editor";
import { artifactKey } from "@cocalc/chat";
jest.mock("@cocalc/frontend/components/theme-editor-modal", () => ({
  ThemeEditorModal: ({ value, onChange, onSave, error }) => (
    <div>
      <input
        aria-label="Theme title"
        value={value.title}
        onChange={(e) => onChange({ title: e.target.value })}
      />
      <button onClick={onSave}>Save</button>
      {error && <div role="alert">{error}</div>}
    </div>
  ),
}));
const theme = {
  title: "Original",
  description: "",
  color: null,
  accent_color: null,
  icon: null,
  image_blob: null,
};
function fixture() {
  const target = { thread_id: "thread", artifact_id: "artifact" };
  const record: any = {
    ...artifactKey(target),
    ...target,
    schema_version: 1,
    kind: "markdown",
    title: "Content title",
    input: "Collaborative text",
    theme,
  };
  const syncdb = {
    get_one: () => record,
    set: jest.fn(),
    commit: jest.fn(),
    save: jest.fn(async () => {}),
  };
  return { record, syncdb };
}
test("appearance save writes only the theme, preserving content", async () => {
  const { record, syncdb } = fixture();
  render(<Editor artifact={record} syncdb={syncdb} onClose={() => {}} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Theme title" }), {
    target: { value: "Chosen title" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(syncdb.save).toHaveBeenCalled());
  expect(syncdb.set).toHaveBeenCalledWith({
    ...artifactKey(record),
    theme: { ...theme, title: "Chosen title" },
  });
});
test("a remote theme change cannot be overwritten by a stale modal", async () => {
  const { record, syncdb } = fixture();
  const { rerender } = render(
    <Editor artifact={record} syncdb={syncdb} onClose={() => {}} />,
  );
  record.theme = { ...theme, title: "Other collaborator" };
  rerender(
    <Editor artifact={{ ...record }} syncdb={syncdb} onClose={() => {}} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert");
  expect(syncdb.set).not.toHaveBeenCalled();
});
