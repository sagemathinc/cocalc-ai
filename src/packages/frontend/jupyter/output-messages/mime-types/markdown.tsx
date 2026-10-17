import register from "./register";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { NotebookMarkdownContext } from "../../notebook-markdown-context";

register("text/markdown", 4, ({ value }) => {
  return (
    <div style={{ margin: "5px 0" }}>
      <NotebookMarkdownContext>
        <StaticMarkdown value={value} />
      </NotebookMarkdownContext>
    </div>
  );
});
