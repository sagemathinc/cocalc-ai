/*
Render a document, where the rendering is determined by the file extension
*/

import ChatViewer from "@cocalc/frontend/chat/viewer";
import { EditableMarkdown } from "@cocalc/frontend/editors/slate/editable-markdown";
import { TasksHistoryViewer } from "@cocalc/frontend/editors/task-editor/history-viewer";
import { getScale } from "@cocalc/frontend/frame-editors/frame-tree/hooks";
import Whiteboard from "@cocalc/frontend/frame-editors/whiteboard-editor/time-travel";
import { HistoryViewer as JupyterHistoryViewer } from "@cocalc/frontend/jupyter/history-viewer";
import type { Document } from "@cocalc/sync/editor/generic/types";
import { timeTravelDocumentSource } from "./document-source";
import { TextDocument } from "./document";
import { isObjectDoc } from "./view-document";

export const HAS_SPECIAL_VIEWER = new Set([
  "tasks",
  "ipynb",
  "board",
  "slides",
  "md",
  "chat",
  "sage-chat",
]);

export function Viewer({
  ext,
  doc,
  textMode,
  id,
  path,
  project_id,
  font_size,
  editor_settings,
  actions,
}: {
  ext: string;
  doc: () => Document | undefined;
  textMode?: boolean;
  id: string;
  path: string;
  project_id: string;
  font_size: number;
  editor_settings;
  actions;
}) {
  const renderText = () => {
    return (
      <TextDocument
        value={() => timeTravelDocumentSource(doc(), ext).text}
        id={id}
        path={path}
        syntaxHighlightExtension={
          ext === "ipynb" || isObjectDoc(path) ? "js" : undefined
        }
        project_id={project_id}
        font_size={font_size}
        editor_settings={editor_settings}
        actions={actions}
      />
    );
  };
  if (textMode) {
    return renderText();
  }
  const opts1 = { doc, project_id, path, font_size, editor_settings };

  switch (ext) {
    case "chat":
    case "sage-chat":
      return <ChatViewer {...opts1} />;
  }

  const opts = { doc: doc(), project_id, path, font_size, editor_settings };
  if (opts.doc == null) {
    return null;
  }

  // CRITICAL: the extensions here *must* also be listed in HAS_SPECIAL_VIEWER above!
  switch (ext) {
    case "tasks":
      return <TasksHistoryViewer {...opts} />;
    case "ipynb":
      return <JupyterHistoryViewer {...opts} />;
    case "md":
      const scale = getScale(font_size);
      return (
        <div
          data-testid="timetravel-markdown-content"
          style={{
            boxSizing: "border-box",
            minHeight: "100%",
            padding: "50px 70px",
          }}
        >
          <EditableMarkdown
            value={doc()?.to_str() ?? "unknown version"}
            read_only
            font_size={font_size}
            hidePath
            disableWindowing
            noVfill
            showEditBar={false}
            height="auto"
            autoMinHeight={0}
            style={{
              fontSize: `${100 * scale}%`,
              backgroundColor: "transparent",
              minHeight: 0,
            }}
            pageStyle={{
              padding: 0,
              background: "transparent",
              minWidth: "100%",
              overflowX: "visible",
            }}
          />
        </div>
      );
    case "board":
      return <Whiteboard {...opts} mainFrameType={"whiteboard"} />;
    case "slides":
      return <Whiteboard {...opts} mainFrameType={"slides"} />;
    default:
      return renderText();
  }
}
