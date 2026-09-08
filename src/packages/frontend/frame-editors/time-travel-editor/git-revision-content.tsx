/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, InputNumber, Space, Spin } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import { filename_extension } from "@cocalc/util/misc";
import { projectGitReader } from "@cocalc/frontend/git/project-read-service";
import { loadGitHistoricalFile } from "@cocalc/frontend/git/historical-file";
import type { GitHistoricalFileRequest } from "@cocalc/frontend/git/historical-file";
import { ViewDocument } from "./view-document";
import { HAS_SPECIAL_VIEWER, Viewer } from "./viewer";
import { TextDocument } from "./document";
import { FrameContext, defaultFrameContext } from "../frame-tree/frame-context";

type LoadedFile = Awaited<ReturnType<typeof loadGitHistoricalFile>>;

export default function GitRevisionContent({
  request,
  fontSize,
}: {
  request: GitHistoricalFileRequest;
  fontSize: number;
}) {
  const [loaded, setLoaded] = useState<{
    request: GitHistoricalFileRequest;
    file: LoadedFile;
  }>();
  const [error, setError] = useState<{
    request: GitHistoricalFileRequest;
    message: string;
  }>();
  useEffect(() => {
    let current = true;
    void loadGitHistoricalFile(projectGitReader, request).then(
      (file) => {
        if (current) setLoaded({ request, file });
      },
      (err) => {
        if (current) setError({ request, message: String(err) });
      },
    );
    return () => {
      current = false;
    };
  }, [request]);
  if (error?.request === request)
    return (
      <Alert
        type="error"
        title="Historical file unavailable"
        description={error.message}
      />
    );
  if (loaded?.request !== request)
    return <Spin aria-label="Loading exact Git revision" />;
  return (
    <GitRevisionDocument
      key={JSON.stringify(loaded.file.source)}
      file={loaded.file}
      fontSize={fontSize}
    />
  );
}

function GitRevisionDocument({
  file,
  fontSize,
}: {
  file: LoadedFile;
  fontSize: number;
}) {
  const editorSettings = useTypedRedux("account", "editor_settings");
  const context = useFileContext();
  const ext = filename_extension(file.source.path).toLowerCase();
  const parsed = useMemo(() => {
    try {
      return {
        doc: new ViewDocument(file.source.path, file.contents),
        error: "",
      };
    } catch (err) {
      return { doc: undefined, error: String(err) };
    }
  }, [file]);
  const [textMode, setTextMode] = useState(false);
  const [line, setLine] = useState<number | null>(1);
  const [position, setPosition] = useState<{ line: number; request: number }>();
  const [lineError, setLineError] = useState("");
  const lineCount = useMemo(
    () => file.contents.split("\n").length,
    [file.contents],
  );
  const path = `${file.source.repository.locator.replace(/\/$/, "")}/${file.source.path}`;
  const rich = HAS_SPECIAL_VIEWER.has(ext) && parsed.doc != null;
  const showText = textMode || !rich;
  return (
    <FrameContext.Provider
      value={{
        ...defaultFrameContext,
        project_id: file.source.repository.projectId,
        path,
        isVisible: true,
        font_size: fontSize,
      }}
    >
      <FileContext.Provider
        value={{
          ...context,
          project_id: file.source.repository.projectId,
          path,
          noSanitize: false,
        }}
      >
        <Space vertical style={{ width: "100%", minWidth: 0 }}>
          {file.deletedIn && (
            <Alert
              type="info"
              title="Deleted file: showing its parent revision"
              description={`This path was deleted in ${file.deletedIn}. No working file is opened or recreated.`}
            />
          )}
          <div style={{ overflowWrap: "anywhere" }}>
            <strong>{file.source.path}</strong>
            <br />
            Revision <code>{file.source.commit}</code>
          </div>
          <Space wrap>
            {rich && (
              <Button onClick={() => setTextMode((value) => !value)}>
                {showText ? "Rendered document" : "Source text"}
              </Button>
            )}
            <InputNumber<number>
              aria-label="Historical source line"
              min={1}
              precision={0}
              value={line}
              onChange={setLine}
            />
            <Button
              onClick={() => {
                if (
                  line == null ||
                  !Number.isInteger(line) ||
                  line < 1 ||
                  line > lineCount
                ) {
                  setLineError(`This revision has ${lineCount} source lines.`);
                  return;
                }
                setLineError("");
                setTextMode(true);
                setPosition((previous) => ({
                  line,
                  request: (previous?.request ?? 0) + 1,
                }));
              }}
            >
              Go to source line
            </Button>
          </Space>
          {lineError && <Alert type="warning" title={lineError} />}
          {parsed.error && (
            <Alert
              type="warning"
              title="Unable to render this document; showing its original source"
              description={parsed.error}
            />
          )}
          {rich && !showText && (
            <Alert
              type="info"
              title="Read-only historical document"
              description="The document is from this Git revision. Linked and embedded resources may refer to live project files or external URLs."
            />
          )}
          <div
            style={{
              height: "60vh",
              minHeight: 200,
              overflow: "auto",
              position: "relative",
            }}
          >
            {showText ? (
              <TextDocument
                id="git-revision-source"
                path={path}
                project_id={file.source.repository.projectId}
                font_size={fontSize}
                editor_settings={editorSettings}
                value={file.contents}
                sourcePosition={position}
              />
            ) : (
              <Viewer
                ext={ext}
                doc={() => parsed.doc}
                id="git-revision-document"
                path={path}
                project_id={file.source.repository.projectId}
                font_size={fontSize}
                editor_settings={editorSettings}
                actions={undefined}
              />
            )}
          </div>
        </Space>
      </FileContext.Provider>
    </FrameContext.Provider>
  );
}
