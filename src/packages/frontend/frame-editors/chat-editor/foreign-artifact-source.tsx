/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Alert, Button } from "antd";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import {
  artifactSyncdbReady,
  useArtifactChanges,
} from "@cocalc/frontend/chat/artifacts";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import {
  ProjectContext,
  useProjectContextProvider,
} from "@cocalc/frontend/project/context";
import getAnchorTagComponent from "@cocalc/frontend/project/page/anchor-tag-component";
import getUrlTransform from "@cocalc/frontend/project/page/url-transform";
import type { Actions } from "./actions";

export interface ForeignArtifactTarget {
  projectId: string;
  path: string;
  threadId: string;
  artifactId: string;
  publicationId?: string;
  agentId?: string;
}

// The workspace owns explicit source navigation. Loading never emits this event.
export const FOREIGN_ARTIFACT_CONVERSATION_EVENT =
  "cocalc:artifact-show-conversation";

export interface ArtifactSourceData {
  projectId: string;
  path: string;
  syncdb: ReturnType<Actions["getArtifactSyncdb"]>;
  readOnly: boolean;
  assertWritable: () => void;
}

function sourceDocumentReady(syncdb: ArtifactSourceData["syncdb"]): boolean {
  if (!artifactSyncdbReady(syncdb)) return false;
  try {
    // Editor readiness is optimistic; the document can still be initializing.
    return !syncdb.get_doc || syncdb.get_doc() != null;
  } catch {
    return false;
  }
}

export function waitForArtifactSourceReady(
  actions: Actions,
  {
    signal,
    timeoutMs = 30_000,
    isCurrent,
  }: {
    signal?: AbortSignal;
    timeoutMs?: number;
    isCurrent: () => boolean;
  },
): Promise<void> {
  const syncdb = actions.getArtifactSyncdb();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const event of ["ready", "change"])
        syncdb?.removeListener(event, check);
      for (const event of ["close", "closed"])
        syncdb?.removeListener(event, closed);
      syncdb?.removeListener("error", failed);
      actions.store?.removeListener("change", check);
      signal?.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    };
    const closed = () =>
      finish(Error("Source conversation closed while loading"));
    const failed = (error: unknown) =>
      finish(Error(`Source conversation failed to load: ${error}`));
    const aborted = () => finish(Error("Source artifact loading cancelled"));
    const check = () => {
      if (signal?.aborted) return aborted();
      if (!isCurrent() || actions.getArtifactSyncdb() !== syncdb)
        return finish(Error("Source conversation replaced while loading"));
      if (actions.isClosed() || syncdb?.get_state?.() === "closed")
        return closed();
      if (syncdb && sourceDocumentReady(syncdb)) finish();
    };
    for (const event of ["ready", "change"]) syncdb?.on(event, check);
    for (const event of ["close", "closed"]) syncdb?.on(event, closed);
    syncdb?.on("error", failed);
    actions.store?.on("change", check);
    signal?.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(
      () => finish(Error("Timed out waiting for source artifact document")),
      timeoutMs,
    );
    check();
  });
}

export async function openForeignArtifactSource(
  target: ForeignArtifactTarget,
  signal?: AbortSignal,
) {
  if (
    !target.projectId ||
    !target.path ||
    !target.threadId ||
    !target.artifactId
  )
    throw Error("Incomplete artifact source descriptor");
  await ensureProjectReduxRuntime();
  const project = redux.getProjectActions(target.projectId);
  if (!project) throw Error("Source project unavailable");
  // A stale catalog entry must not create an empty source conversation.
  await project.fs().stat(target.path);
  // Use the normal authorized project/host path. Do not navigate, focus a
  // composer, or pass a fragment (even for a different thread in this chat).
  await project.open_file({
    path: target.path,
    embedded: true,
    foreground: false,
    foreground_project: false,
    change_history: false,
    wait_for_ready: true,
  });
  const actions = redux.getEditorActions(target.projectId, target.path) as
    | Actions
    | undefined;
  if (!actions || actions.isClosed() || !actions.getArtifactSyncdb?.())
    throw Error("Source chat runtime unavailable");
  const syncdb = actions.getArtifactSyncdb();
  if (signal?.aborted) throw Error("Source artifact loading cancelled");
  await waitForArtifactSourceReady(actions, {
    signal,
    isCurrent: () =>
      redux.getEditorActions(target.projectId, target.path) === actions,
  });
  if (signal?.aborted) throw Error("Source artifact loading cancelled");
  if (
    actions.isClosed() ||
    redux.getEditorActions(target.projectId, target.path) !== actions ||
    actions.getArtifactSyncdb() !== syncdb ||
    !sourceDocumentReady(syncdb)
  )
    throw Error("Source conversation closed or replaced while loading");
  return actions;
}

export default function ForeignArtifactSource({
  target,
  children,
  showForeignContextWarning = true,
}: {
  target: ForeignArtifactTarget;
  children: (source: ArtifactSourceData) => ReactNode;
  showForeignContextWarning?: boolean;
}) {
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState<Actions>();
  const openFiles = useTypedRedux(
    { project_id: target.projectId },
    "open_files",
  );
  const component = openFiles?.getIn?.([target.path, "component"]) as
    | { Editor?: unknown; redux_name?: string; runtime_generation?: number }
    | undefined;
  const context = useProjectContextProvider({
    project_id: target.projectId,
    is_active: false,
    mainWidthPx: 900,
    manageWorkspaceSelection: false,
  });
  const fileContext = useFileContext();
  const allowed = context.projectAccess.capabilities.useProjectRuntime;
  useEffect(() => {
    let disposed = false;
    const abort = new AbortController();
    setLoaded(undefined);
    setError("");
    if (!allowed) return;
    void openForeignArtifactSource(target, abort.signal).then(
      (actions) => {
        if (!disposed) setLoaded(actions);
      },
      (err) => {
        if (!disposed) setError(String(err));
      },
    );
    return () => {
      disposed = true;
      abort.abort();
    };
  }, [
    target.projectId,
    target.path,
    target.threadId,
    target.artifactId,
    retry,
    allowed,
  ]);
  const syncdb = loaded?.getArtifactSyncdb();
  useArtifactChanges(syncdb);
  const [, refresh] = useState(0);
  useEffect(() => {
    const changed = () => refresh((n) => n + 1);
    loaded?.store?.on("change", changed);
    syncdb?.on("close", changed);
    syncdb?.on("metadata-change", changed);
    return () => {
      loaded?.store?.removeListener("change", changed);
      syncdb?.removeListener("close", changed);
      syncdb?.removeListener("metadata-change", changed);
    };
  }, [loaded, syncdb]);
  const runtimeIsCurrent = () =>
    !!loaded &&
    redux.getEditorActions(target.projectId, target.path) === loaded &&
    !loaded.isClosed() &&
    loaded.getArtifactSyncdb() === syncdb &&
    sourceDocumentReady(syncdb!);
  // Background open_file initializes Redux without generating a React Editor.
  // This surface consumes the document, not EmbeddedProjectFile, so an empty
  // component shell is valid. Keep the open_files subscription above to detect
  // runtime replacement, but validate the registered source actions directly.
  const readOnly =
    !!loaded?.store?.get("read_only") || !!syncdb?.is_read_only?.();
  const assertWritable = () => {
    if (
      !allowed ||
      !runtimeIsCurrent() ||
      loaded?.store?.get("read_only") ||
      syncdb?.is_read_only?.()
    )
      throw Error(
        "Source artifact is no longer writable. Retry loading its conversation.",
      );
  };
  const writable = useRef(assertWritable);
  writable.current = assertWritable;
  const guarded = useRef<
    | {
        raw: typeof syncdb;
        value: typeof syncdb;
        actions: typeof loaded;
        generation: number;
      }
    | undefined
  >(undefined);
  if (
    syncdb &&
    (guarded.current?.raw !== syncdb || guarded.current?.actions !== loaded)
  ) {
    // Appearance editing also writes through this handle. Guard at mutation
    // time, including callbacks queued before runtime closure or replacement.
    const sourceActions = loaded;
    guarded.current = {
      raw: syncdb,
      actions: loaded,
      generation: (guarded.current?.generation ?? 0) + 1,
      value: new Proxy(syncdb, {
        get(raw, key) {
          const value = Reflect.get(raw, key);
          if (typeof value !== "function") return value;
          return (...args) => {
            if (
              key === "set" ||
              key === "delete" ||
              key === "commit" ||
              key === "save"
            ) {
              if (
                guarded.current?.raw !== raw ||
                redux.getEditorActions(target.projectId, target.path) !==
                  sourceActions
              )
                throw Error("Source artifact runtime was replaced");
              writable.current();
            }
            return value.apply(raw, args);
          };
        },
      }),
    };
  }
  useEffect(
    () => () => {
      writable.current = () => {
        throw Error("Source artifact has been unmounted");
      };
    },
    [],
  );
  function showConversation() {
    window.dispatchEvent(
      new CustomEvent(FOREIGN_ARTIFACT_CONVERSATION_EVENT, {
        detail: {
          project_id: target.projectId,
          path: target.path,
          thread_id: target.threadId,
          artifact_id: target.artifactId,
          agent_id: target.agentId,
          operation_id: target.publicationId,
        },
      }),
    );
  }
  const unavailable = !allowed
    ? "Source project access is unavailable"
    : error ||
      (loaded && !runtimeIsCurrent()
        ? "Source conversation closed or reloaded"
        : "");
  if (unavailable)
    return (
      <Alert
        type="warning"
        title="Artifact source unavailable"
        description={unavailable}
        action={<Button onClick={() => setRetry((n) => n + 1)}>Retry</Button>}
      />
    );
  if (!loaded || !syncdb)
    return <div role="status">Loading artifact source...</div>;
  return (
    <ProjectContext.Provider value={context}>
      <FileContext.Provider
        value={{
          ...fileContext,
          project_id: target.projectId,
          path: target.path,
          noSanitize: false,
          anchorTagAction: undefined,
          AnchorTagComponent: getAnchorTagComponent({
            project_id: target.projectId,
            path: target.path,
          }),
          urlTransform: getUrlTransform({
            project_id: target.projectId,
            path: target.path,
          }),
        }}
      >
        <div className="smc-vfill" style={{ minHeight: 0 }}>
          {showForeignContextWarning && (
            <div role="note">
              This artifact belongs to another conversation. Comments, action
              review, and agent requests are disabled here.
              <Button onClick={() => void showConversation()}>
                Show in conversation
              </Button>
            </div>
          )}
          <Fragment
            key={`${component?.runtime_generation}:${guarded.current!.generation}`}
          >
            {children({
              projectId: target.projectId,
              path: target.path,
              syncdb: guarded.current!.value!,
              readOnly,
              assertWritable,
            })}
          </Fragment>
        </div>
      </FileContext.Provider>
    </ProjectContext.Provider>
  );
}
