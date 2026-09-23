import { useEffect, useRef, useState } from "react";
import { Alert, Button, Space } from "antd";
import { redux } from "@cocalc/frontend/app-framework";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { ReadonlyNotebook } from "@cocalc/frontend/jupyter/readonly-notebook";
import type { ReadonlyNotebookDocument } from "@cocalc/frontend/jupyter/readonly-notebook";

export default function NotebookArtifact({
  projectId,
  path,
  historical = false,
}: {
  projectId: string;
  path: string;
  historical?: boolean;
}) {
  const { actions } = useProjectContext();
  const [doc, setDoc] = useState<ReadonlyNotebookDocument>();
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [retry, setRetry] = useState(0);
  const scrollPosition = useRef(0);
  useEffect(() => {
    let disposed = false;
    let detach = () => {};
    setDoc(undefined);
    setError("");
    setConnected(false);
    void (async () => {
      if (!actions) throw Error("Project unavailable");
      // Check existence before opening: an absent artifact must not create a notebook.
      await actions.fs().stat(path);
      if (disposed) return;
      await actions.open_file({
        path,
        embedded: true,
        foreground: false,
        foreground_project: false,
        wait_for_ready: true,
        change_history: false,
      });
      if (disposed) return;
      const notebook = redux.getEditorActions(projectId, path)?.jupyter_actions;
      const syncdb = notebook?.syncdb;
      if (!syncdb) throw Error("Notebook session unavailable");
      const refresh = () => {
        if (disposed) return;
        if (syncdb.isReady()) setDoc(syncdb.get_doc());
        setConnected(syncdb.is_live_connected?.() ?? syncdb.isReady());
      };
      const closed = () => {
        if (disposed) return;
        setConnected(false);
        setError(
          "The notebook session closed. Reconnect to continue viewing it.",
        );
      };
      for (const event of ["change", "ready", "connected", "disconnected"])
        syncdb.on(event, refresh);
      syncdb.on("close", closed);
      detach = () => {
        for (const event of ["change", "ready", "connected", "disconnected"])
          syncdb.removeListener(event, refresh);
        syncdb.removeListener("close", closed);
      };
      refresh();
    })().catch((err) => {
      if (!disposed) setError(String(err));
    });
    return () => {
      disposed = true;
      detach();
      // The project owns this runtime; never close another view's session.
    };
  }, [actions, projectId, path, retry]);
  return (
    <KeyboardBoundary
      className="smc-vfill"
      style={{ minHeight: 0, padding: 12 }}
    >
      <Space wrap style={{ flexShrink: 0, marginBottom: 8 }}>
        <Button
          onClick={() =>
            void actions
              ?.open_file({ path })
              .catch((err) => setError(String(err)))
          }
        >
          Open in project
        </Button>
        <Button
          onClick={() =>
            void actions
              ?.download_file({ path, log: true })
              .catch((err) => setError(String(err)))
          }
        >
          Download saved notebook
        </Button>
        <Button onClick={() => setRetry((n) => n + 1)}>Reconnect</Button>
        <span role="status">
          {connected
            ? "Live notebook"
            : doc
              ? "Disconnected: last received contents"
              : "Connecting to notebook..."}
        </span>
      </Space>
      <div role="note" style={{ flexShrink: 0, marginBottom: 8 }}>
        Read-only preview. Opening does not run cells. Outputs may be from an
        earlier version of the code.
        {historical &&
          " This reference shows the current notebook, not a historical snapshot."}
      </div>
      {error && <Alert type="warning" title={error} />}
      {doc && (
        <ReadonlyNotebook
          project_id={projectId}
          path={path}
          doc={doc}
          scrollPosition={scrollPosition}
        />
      )}
    </KeyboardBoundary>
  );
}
