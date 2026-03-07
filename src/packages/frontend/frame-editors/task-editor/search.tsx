import { createSearchEditor } from "@cocalc/frontend/frame-editors/generic/search";
import { defaultTasksMarkdownSurface } from "@cocalc/frontend/editors/task-editor/default-adapters";

export const DONE = "☑ ";

function Preview({ content }) {
  const { StaticMarkdown } = defaultTasksMarkdownSurface;
  return (
    <StaticMarkdown
      value={content}
      style={{
        marginBottom: "-10px" /* account for <p> */,
        opacity: content.startsWith(DONE) ? 0.5 : undefined,
      }}
    />
  );
}

export const search = createSearchEditor({
  Preview,
  updateField: "tasks",
  title: "Task List",
});
