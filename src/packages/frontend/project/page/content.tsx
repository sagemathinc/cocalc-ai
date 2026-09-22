/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
This is a component that has three props:

  - project_id
  - tab_name -- 'files', 'new', 'log', 'search', 'settings', and 'editor-[path]'
  - is_visible

and it displays the file as an editor associated with that path in the project,
or Loading... if the file is still being loaded.
*/

import { Alert, Button } from "antd";
import $ from "jquery";
import { Map } from "immutable";
import { debounce } from "lodash";
import { Suspense, useCallback, useEffect, useMemo, useRef } from "react";
import Draggable from "react-draggable";
import { React, redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { alert_message } from "@cocalc/frontend/alerts";
import { CocalcErrorBoundary } from "@cocalc/frontend/app/error-boundary";
import { KioskModeBanner } from "@cocalc/frontend/app/kiosk-mode-banner";
import { lazyWithRetry } from "@cocalc/frontend/app/lazy-with-retry";
import { isReactDomMutationError } from "@cocalc/frontend/app/react-dom-mutation";
import { getExternalSideChatDesc } from "@cocalc/frontend/chat/external-side-chat-selection";
import { chatMetaFile } from "@cocalc/frontend/chat/paths";
import type { ChatState } from "@cocalc/frontend/chat/chat-indicator";
import { Loading } from "@cocalc/frontend/components";
import KaTeX from "@cocalc/frontend/components/math/lazy-katex";
import getMermaid from "@cocalc/frontend/editors/slate/elements/code-block/get-mermaid";
import { IS_MOBILE, IS_TOUCH } from "@cocalc/frontend/feature";
import { lite } from "@cocalc/frontend/lite";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import {
  drag_start_iframe_disable,
  drag_stop_iframe_enable,
} from "@cocalc/frontend/misc";
import DeletedFile from "@cocalc/frontend/project/deleted-file";
import { Explorer } from "@cocalc/frontend/project/explorer";
import {
  isFixedTab,
  type FixedTab,
} from "@cocalc/frontend/project/page/file-tab";
import { openFileComponentRuntimeIsUsable } from "@cocalc/frontend/project/redux/open-file-runtime";
import { editor_id } from "@cocalc/frontend/project/utils";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { unreachable } from "@cocalc/util/misc";
import { useProjectContext } from "../context";
import getAnchorTagComponent from "./anchor-tag-component";
import getUrlTransform from "./url-transform";

const AgentsPanel = lazyWithRetry(
  async () => ({
    default: (await import("./flyouts/agents")).AgentsPanel,
  }),
  "project agents panel",
);
const ProjectComputeVms = lazyWithRetry(
  async () => ({
    default: (await import("@cocalc/frontend/project/compute-vms"))
      .ProjectComputeVms,
  }),
  "project virtual machines panel",
);
const ProjectDocsPanel = lazyWithRetry(
  async () => ({
    default: (await import("./flyouts/docs")).ProjectDocsPanel,
  }),
  "project docs panel",
);
const ProjectInfo = lazyWithRetry(
  async () => ({
    default: (await import("@cocalc/frontend/project/info")).ProjectInfo,
  }),
  "project process information panel",
);
const ProjectLog = lazyWithRetry(
  async () => ({
    default: (await import("@cocalc/frontend/project/history")).ProjectLog,
  }),
  "project log panel",
);
const ProjectNew = lazyWithRetry(
  async () => ({
    default: (await import("@cocalc/frontend/project/new")).ProjectNew,
  }),
  "project new-file panel",
);
const ProjectSearch = lazyWithRetry(
  async () => ({
    default: (await import("@cocalc/frontend/project/search/search"))
      .ProjectSearch,
  }),
  "project search panel",
);
const ProjectServers = lazyWithRetry(
  async () => ({
    default: (await import("@cocalc/frontend/project/servers")).ProjectServers,
  }),
  "project app servers panel",
);
const ProjectSettings = lazyWithRetry(
  async () => ({
    default: (await import("@cocalc/frontend/project/settings"))
      .ProjectSettings,
  }),
  "project settings panel",
);
const RootfsPanel = lazyWithRetry(
  async () => ({
    default: (await import("./flyouts/rootfs")).RootfsPanel,
  }),
  "project image panel",
);
const WorkspacesPanel = lazyWithRetry(
  async () => ({
    default: (await import("./flyouts/workspaces")).WorkspacesPanel,
  }),
  "project workspaces panel",
);
const SideChat = lazyWithRetry(
  () => import("@cocalc/frontend/chat/side-chat"),
  "external side chat",
);

// Default width of chat window as a fraction of the
// entire window.
const DEFAULT_CHAT_WIDTH = IS_MOBILE ? 0.5 : 0.3;

const MAIN_STYLE: React.CSSProperties = {
  overflowX: "auto",
  position: "absolute",
  inset: 0,
} as const;

const VIEWER_ALLOWED_TABS = new Set([
  "active",
  "docs",
  "files",
  "home",
  "users",
]);

interface Props {
  tab_name: string; // e.g., 'files', 'new', 'log', 'search', 'settings', 'agents', or 'editor-<path>'
  is_visible: boolean; // if false, editor is in the DOM (so all subtle DOM state preserved) but it is not visible on screen.
}

export const Content: React.FC<Props> = (props: Props) => {
  const { tab_name, is_visible } = props;
  const { setContentSize } = useProjectContext();
  const contentRef = useRef<HTMLDivElement>(null);

  const debouncedMeasure = useCallback(
    debounce((entries: ResizeObserverEntry[]) => {
      if (entries.length > 0) {
        const { width, height } = entries[0].contentRect;
        setContentSize({ width, height });
      }
    }, 10),
    [setContentSize],
  );

  useEffect(() => {
    if (!contentRef.current) return;

    const resizeObserver = new ResizeObserver(debouncedMeasure);
    resizeObserver.observe(contentRef.current);

    return () => {
      resizeObserver.disconnect();
      debouncedMeasure.cancel();
    };
  }, [debouncedMeasure]);

  // The className below is so we always make this div the remaining height.
  // The overflowY is hidden for editors and the process-info tab, which each
  // manage their own internal scrolling. Other tabs (e.g., settings) still use
  // page-level scrolling. See https://github.com/sagemathinc/cocalc/pull/4708.
  const hideOuterScroll = tab_name.startsWith("editor-") || tab_name === "info";
  return (
    <div
      ref={contentRef}
      style={{
        ...MAIN_STYLE,
        ...(is_visible
          ? {
              opacity: 1,
              pointerEvents: "auto",
              zIndex: 1,
              visibility: "visible",
            }
          : {
              opacity: 0,
              pointerEvents: "none",
              zIndex: 0,
              visibility: "hidden",
            }),
        ...{ overflowY: hideOuterScroll ? "hidden" : "auto" },
      }}
      aria-hidden={!is_visible}
      className={"smc-vfill"}
    >
      <TabContent tab_name={tab_name} is_visible={is_visible} />
    </div>
  );
};

interface TabContentProps {
  tab_name: string;
  is_visible: boolean;
}

const TabContent: React.FC<TabContentProps> = (props: TabContentProps) => {
  const { tab_name, is_visible } = props;
  const { agentAIEnabled, project_id, projectAccess } = useProjectContext();
  const computeVmEnabled =
    useTypedRedux("customize", "compute_vm_enabled") === true;

  const open_files =
    useTypedRedux({ project_id }, "open_files") ?? Map<string, any>();
  const fullscreen = useTypedRedux("page", "fullscreen");
  const recentlyDeletedPaths: Map<string, number> | undefined = useTypedRedux(
    { project_id },
    "recentlyDeletedPaths",
  );

  const path = useMemo(() => {
    if (tab_name.startsWith("editor-")) {
      return tab_name.slice("editor-".length);
    } else {
      return "";
    }
  }, [tab_name]);

  const lastIsVisibleRef = useRef<boolean>(is_visible);
  useEffect(() => {
    if (!is_visible && lastIsVisibleRef.current) {
      // a tab changed to not be visible, so let it know, so it can
      // remove its keyboard handler.
      if (tab_name.startsWith("editor-")) {
        const syncPath =
          (open_files.getIn([path, "sync_path"]) as string) ?? path;
        // if the actions are defined and there is a blur method, call it.
        redux.getEditorActions(project_id, syncPath)?.["blur"]?.();
      }
    }
    lastIsVisibleRef.current = is_visible;
  }, [is_visible, open_files, path, project_id, tab_name]);

  // show the kiosk mode banner instead of anything besides a file editor
  if (fullscreen === "kiosk" && !tab_name.startsWith("editor-")) {
    return <KioskModeBanner />;
  }

  if (lite && (tab_name === "rootfs" || tab_name === "settings")) {
    return null;
  }

  if (
    projectAccess.role === "viewer" &&
    !tab_name.startsWith("editor-") &&
    !VIEWER_ALLOWED_TABS.has(tab_name)
  ) {
    return (
      <Alert
        showIcon
        type="info"
        style={{ margin: "24px" }}
        title="Viewer access is read-only"
        description="Viewers can browse and open allowed project files, but cannot create files, start runtimes, use terminals, open app servers, run agents, or change project settings."
      />
    );
  }

  // Legacy in-memory state from the old project-home page.
  if (tab_name === "home") {
    return <Explorer isVisible={is_visible} />;
  }

  if (isFixedTab(tab_name)) {
    return (
      <CocalcErrorBoundary
        fallback={
          <Alert
            action={
              <Button onClick={() => window.location.reload()}>
                Reload CoCalc
              </Button>
            }
            description="The panel assets could not be loaded. The error was reported automatically; reload CoCalc to use this panel."
            showIcon
            title="This project panel could not be displayed"
            type="warning"
          />
        }
        resetKeys={[tab_name]}
        scope={`project.panel.${tab_name}`}
      >
        <Suspense fallback={<Loading theme="medium" />}>
          {renderFixedTabContent(tab_name)}
        </Suspense>
      </CocalcErrorBoundary>
    );
  }

  // check for "editor-[filename]"
  if (!tab_name.startsWith("editor-")) {
    return <Loading theme="medium" />;
  }

  const value = {
    urlTransform: getUrlTransform({ project_id, path }),
    AnchorTagComponent: getAnchorTagComponent({ project_id, path }),
    noSanitize: true, // TODO: temporary for backward compat for now; will make it user-configurable on a per file basis later.
    MathComponent: KaTeX,
    hasLanguageModel: redux
      ?.getStore("projects")
      .hasLanguageModelEnabled(project_id),
    disableMarkdownCodebar: redux
      ?.getStore("account")
      .getIn(["other_settings", "disable_markdown_codebar"]),
    disableExtraButtons: false,
    project_id,
    path,
    is_visible,
    client: webapp_client,
    getMermaid,
  };
  return (
    <FileContext.Provider value={value}>
      <EditorContent
        project_id={project_id}
        path={path}
        is_visible={is_visible}
        chatState={open_files.getIn([path, "chatState"]) as any}
        chat_width={
          (open_files.getIn([path, "chat_width"]) as any) ?? DEFAULT_CHAT_WIDTH
        }
        component={open_files.getIn([path, "component"]) ?? {}}
        deleted={recentlyDeletedPaths?.get(path)}
      />
    </FileContext.Provider>
  );

  function renderFixedTabContent(tab: FixedTab): React.JSX.Element | null {
    switch (tab) {
      case "active":
        // This activity-bar-only tab has no full-page representation.
        return null;
      case "files":
        return <Explorer isVisible={is_visible} />;
      case "new":
        return <ProjectNew project_id={project_id} isVisible={is_visible} />;
      case "log":
        return <ProjectLog project_id={project_id} isVisible={is_visible} />;
      case "search":
        return <ProjectSearch />;
      case "servers":
        return <ProjectServers />;
      case "settings":
      case "users":
        return <ProjectSettings project_id={project_id} />;
      case "info":
        return <ProjectInfo project_id={project_id} />;
      case "vms":
        if (!computeVmEnabled) return null;
        return (
          <ProjectComputeVms project_id={project_id} isVisible={is_visible} />
        );
      case "agents":
        if (!agentAIEnabled) {
          return (
            <Alert
              showIcon
              type="info"
              style={{ margin: "24px" }}
              title="AI integrations are disabled"
              description="Agents are hidden because AI integrations are disabled for this account or project."
            />
          );
        }
        return <AgentsPanel project_id={project_id} layout="page" />;
      case "docs":
        return <ProjectDocsPanel project_id={project_id} layout="page" />;
      case "workspaces":
        return <WorkspacesPanel project_id={project_id} layout="page" />;
      case "rootfs":
        return <RootfsPanel layout="page" />;
      default:
        unreachable(tab);
        return null;
    }
  }
};

/** Render one project editor without the surrounding project desktop. */
export function EmbeddedProjectFile({
  path,
  isVisible,
}: {
  path: string;
  isVisible: boolean;
}) {
  return <TabContent tab_name={`editor-${path}`} is_visible={isVisible} />;
}

interface EditorProps {
  path: string;
  project_id: string;
  is_visible: boolean;
  isViewer: boolean;
  // NOTE: this "component" part is a plain
  // object, and is not an immutable.Map, since
  // it has to store a react component.
  component: { Editor?; redux_name?: string; runtime_generation?: number };
}

const Editor: React.FC<EditorProps> = (props: EditorProps) => {
  const { path, project_id, is_visible, isViewer, component } = props;
  const { actions: projectActions } = useProjectContext();
  const { Editor: EditorComponent, redux_name } = component;
  const actions =
    redux_name != null ? (redux.getActions(redux_name) as any) : undefined;
  const runtimeIsUsable = openFileComponentRuntimeIsUsable({
    info: component,
    isViewer,
    getActions: (name) => redux.getActions(name),
    getStore: (name) => redux.getStore(name),
  });
  useEffect(() => {
    if (runtimeIsUsable) return;
    projectActions?.ensure_open_file_component?.(path, { noFocus: true });
  }, [projectActions, path, runtimeIsUsable]);
  if (!runtimeIsUsable) {
    return <Loading theme={"medium"} />;
  }

  return (
    <div
      className="smc-vfill notranslate"
      id={editor_id(project_id, path)}
      style={{ height: "100%" }}
      translate="no"
    >
      <EditorComponent
        name={actions?.name}
        path={path}
        project_id={project_id}
        redux={redux}
        actions={actions}
        is_visible={is_visible}
      />
    </div>
  );
};

interface EditorContentProps {
  project_id: string;
  path: string;
  is_visible: boolean;
  chat_width: number;
  chatState?: ChatState;
  component: { Editor?; redux_name?: string; runtime_generation?: number };
  // if deleted, when
  deleted?: number;
}

const EditorContent: React.FC<EditorContentProps> = ({
  deleted,
  project_id,
  path,
  chat_width,
  is_visible,
  chatState,
  component,
}: EditorContentProps) => {
  const { projectAccess } = useProjectContext();
  const editor_container_ref = useRef<any>(null);
  const sideChatDesc = useMemo(
    () => getExternalSideChatDesc(project_id, path),
    [project_id, path],
  );

  if (deleted) {
    return <DeletedFile project_id={project_id} path={path} time={deleted} />;
  }

  // Render this here, since it is used in multiple places below.
  const editor = (
    <CocalcErrorBoundary
      autoRetry={({ error, retryCount }) =>
        retryCount === 0 && isReactDomMutationError(error)
      }
      onAutoRetry={() =>
        alert_message({
          type: "info",
          title: "Editor recovered",
          message: "CoCalc automatically reloaded the affected editor.",
          timeout: 4,
        })
      }
      resetKeys={[component.redux_name, component.runtime_generation]}
      scope="project.editor"
      fallback={({ error, retry }) =>
        isReactDomMutationError(error) ? (
          <Alert
            action={<Button onClick={retry}>Reload editor</Button>}
            description="Page translation or a browser extension may be modifying CoCalc's editor content. Disable translation and page-modifying extensions for cocalc.ai, then reload the editor. The error was reported automatically; other project tools remain available."
            title="The editor could not recover from a browser page change"
            showIcon
            type="warning"
          />
        ) : (
          <Alert
            action={<Button onClick={retry}>Reload editor</Button>}
            description="The error was reported automatically. Other project tools remain available."
            title="This editor could not be displayed"
            showIcon
            type="warning"
          />
        )
      }
    >
      <Editor
        key={`${component.redux_name ?? "loading"}:${
          component.runtime_generation ?? 0
        }`}
        project_id={project_id}
        path={path}
        is_visible={is_visible}
        isViewer={projectAccess.role === "viewer"}
        component={component}
      />
    </CocalcErrorBoundary>
  );

  let content: React.JSX.Element;
  if (chatState == "external" && projectAccess.role !== "viewer") {
    // 2-column layout with chat
    content = (
      <div
        style={{
          position: "absolute",
          height: "100%",
          width: "100%",
          display: "flex",
        }}
        ref={editor_container_ref}
      >
        <div
          style={{
            flex: 1,
            overflow: "hidden",
            height: "100%",
            width: "100%",
          }}
        >
          {editor}
        </div>
        <DragBar
          editor_container_ref={editor_container_ref}
          project_id={project_id}
          path={path}
        />
        <div
          style={{
            position: "relative",
            flexBasis: `${chat_width * 100}%`,
          }}
        >
          <CocalcErrorBoundary
            scope="project.external-side-chat"
            resetKeys={[project_id, path]}
          >
            <Suspense fallback={<Loading theme="medium" />}>
              <SideChat
                style={{ position: "absolute" }}
                project_id={project_id}
                path={chatMetaFile(path)}
                desc={sideChatDesc}
              />
            </Suspense>
          </CocalcErrorBoundary>
        </div>
      </div>
    );
  } else {
    // just the editor
    content = (
      <div
        className="smc-vfill"
        style={{ position: "absolute", height: "100%", width: "100%" }}
      >
        {editor}
      </div>
    );
  }

  return content;
};

interface DragBarProps {
  project_id: string;
  path: string;
  editor_container_ref;
}

const DragBar: React.FC<DragBarProps> = (props: DragBarProps) => {
  const { project_id, path, editor_container_ref } = props;
  const nodeRef = useRef<any>({});
  const draggable_ref = useRef<any>(null);

  const reset = () => {
    if (draggable_ref.current == null) {
      return;
    }
    /* This is ugly and dangerous, but I don't know any other way to
       reset the state of the bar, so it fits back into our flex
       display model, besides writing something like the Draggable
       component from scratch for our purposes. For now, this will do: */
    if (draggable_ref.current?.state != null) {
      draggable_ref.current.state.x = 0;
    }
    $(draggable_ref.current).css("transform", "");
  };

  const handle_drag_bar_stop = (_, ui) => {
    const clientX = ui.node.offsetLeft + ui.x + $(ui.node).width() + 2;
    drag_stop_iframe_enable();
    const elt = $(editor_container_ref.current);
    const offset = elt.offset();
    if (offset == null) return;
    const elt_width = elt.width();
    if (!elt_width) return;
    const width = 1 - (clientX - offset.left) / elt_width;
    reset();
    redux.getProjectActions(project_id).set_chat_width({ path, width });
  };

  return (
    <Draggable
      nodeRef={nodeRef}
      position={{ x: 0, y: 0 }}
      ref={draggable_ref}
      axis="x"
      onStop={handle_drag_bar_stop}
      onStart={drag_start_iframe_disable}
      defaultClassNameDragging={"cc-vertical-drag-bar-dragging"}
    >
      <div
        ref={nodeRef}
        className="cc-vertical-drag-bar"
        style={IS_TOUCH ? { width: "12px" } : undefined}
      >
        {" "}
      </div>
    </Draggable>
  );
};
