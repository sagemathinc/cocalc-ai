/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useState } from "react";
import { Alert, Button } from "antd";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import { redux } from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import {
  ProjectContext,
  useProjectContextProvider,
} from "@cocalc/frontend/project/context";
import { EmbeddedProjectFile } from "@cocalc/frontend/project/page/content";
import { ChatEmbeddingOptionsProvider } from "@cocalc/frontend/chat/embedding-options";

/** Open the canonical workbench, including unnamed/shared agents, without
 * creating an identity, alias, enrollment, turn, or payment configuration.
 */
export function EmbeddedConversation({
  resource,
  accountId,
}: {
  resource: CollaborationResource;
  accountId: string;
}) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | undefined;
    setReady(false);
    setError("");
    const current = () =>
      !cancelled && redux.getStore("account")?.get("account_id") === accountId;
    void (async () => {
      await ensureProjectReduxRuntime();
      if (!current()) return;
      const project = redux.getProjectActions(resource.project_id);
      if (!project) throw Error("This project is unavailable.");
      await project.fs().stat(resource.chat_path);
      if (!current()) return;
      const alreadyOpen = redux
        .getProjectStore(resource.project_id)
        ?.get("open_files")
        ?.has(resource.chat_path);
      release = () => {
        // Do not close a file that was already open, or that the user opened in
        // a project tab while this embedded workbench was active.
        const tabs = redux
          .getProjectStore(resource.project_id)
          ?.get("open_files_order");
        if (!alreadyOpen && !tabs?.includes(resource.chat_path))
          project.close_file(resource.chat_path);
      };
      await project.open_file({
        path: resource.chat_path,
        embedded: true,
        foreground: false,
        foreground_project: false,
        wait_for_ready: true,
        change_history: false,
        fragmentId: { thread: resource.thread_id },
      });
      if (!current()) {
        release();
        return;
      }
      setReady(true);
    })().catch((error) => {
      if (current()) setError(String(error));
    });
    return () => {
      cancelled = true;
      release?.();
    };
  }, [
    accountId,
    resource.project_id,
    resource.chat_path,
    resource.thread_id,
    retry,
  ]);
  if (error)
    return (
      <Alert
        role="alert"
        type="error"
        title="Workbench unavailable"
        description={error}
        action={
          <Button onClick={() => setRetry((n) => n + 1)}>
            Retry workbench
          </Button>
        }
      />
    );
  if (!ready)
    return <p role="status">Opening the original conversation workbench...</p>;
  return <Workbench resource={resource} />;
}

function Workbench({ resource }: { resource: CollaborationResource }) {
  const context = useProjectContextProvider({
    project_id: resource.project_id,
    is_active: true,
    mainWidthPx: 900,
    manageWorkspaceSelection: false,
  });
  return (
    <ProjectContext.Provider value={context}>
      <ChatEmbeddingOptionsProvider
        value={{
          agentWorkspace: true,
          agentWorkspaceActive: true,
          disableConversationFocus: true,
          hideSingleFrameToolbar: true,
          hideCompactThreadHeader: true,
          openFilesInWorkbench: true,
          sidebarHiddenByDefault: true,
        }}
      >
        <div className="collaborators-chat">
          <EmbeddedProjectFile path={resource.chat_path} isVisible />
        </div>
      </ChatEmbeddingOptionsProvider>
    </ProjectContext.Provider>
  );
}
