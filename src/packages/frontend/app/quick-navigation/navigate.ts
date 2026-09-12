/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import { openAccountSettings } from "@cocalc/frontend/account/settings-routing";
import { openAppDocs, openProjectDocs } from "@cocalc/frontend/docs/navigation";
import type { Destination } from "./model";
import { activateProjectTab } from "@cocalc/frontend/project/page/activate-project-tab";
import { FIXED_PROJECT_TABS } from "@cocalc/frontend/project/page/file-tab";

import { refocusChatComposerInput } from "@cocalc/frontend/chat/composer-focus";
import { FRAME_COMMIT_EVENT } from "@cocalc/frontend/frame-editors/frame-tree/commit-event";
import { getLogger } from "@cocalc/frontend/logger";
import { storeChanges, waitUntil } from "./wait-until";

const logger = getLogger("quick-navigation");
const nextFrame = () =>
  new Promise<void>((resolve) =>
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(() => resolve())
      : setTimeout(resolve, 16),
  );

export const HELP_SLUG = "documentation/quick-navigation";
function frameRoot(frameId: string): HTMLElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-frame-id]"),
  ).find(
    (el) => el.dataset.frameId === frameId && el.getClientRects().length > 0,
  );
}

// The layout actions select the frame; the file's own actions own the actual
// CodeMirror instance (notably included LaTeX files). Never focus the outer DOM
// region after focusing CodeMirror, since that removes its text cursor.
export function focusFrame(actions: any, frameId: string): boolean {
  const fileActions =
    actions.get_code_editor?.(frameId)?.get_actions() ?? actions;
  const cm = fileActions._cm?.[frameId];
  if (cm) {
    cm.focus();
    return cm.hasFocus();
  }
  // A subfile manager may still be initializing. Do not accept its empty outer
  // frame as success before the embedded CodeMirror has mounted.
  const type = actions._get_frame_node?.(frameId)?.get("type");
  if (type === "cm") return false;
  actions.focus?.(frameId);
  const root = frameRoot(frameId);
  if (!root) return false;
  if (type === "chat" && refocusChatComposerInput(root)) return true;
  if (!root.contains(document.activeElement)) {
    // Only make passive regions focusable for this handoff. Ordinary pointer
    // clicks elsewhere in the editor must keep their existing focus behavior.
    root.tabIndex = -1;
    root.addEventListener("blur", () => root.removeAttribute("tabindex"), {
      once: true,
    });
    root.focus({ preventScroll: true });
  }
  return root.contains(document.activeElement);
}

export async function navigate(
  destination: Destination,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  if (destination.kind === "settings") {
    openAccountSettings({ page: destination.page });
    return;
  }
  if (destination.kind === "docs") {
    if (destination.projectId)
      openProjectDocs({ projectId: destination.projectId, slug: HELP_SLUG });
    else openAppDocs(HELP_SLUG);
    const search = await waitUntil(
      () =>
        Array.from(
          document.querySelectorAll<HTMLElement>(
            '[aria-label="Search documentation"]',
          ),
        ).find((el) => el.getClientRects().length > 0),
      (check) => {
        const observer = new MutationObserver(check);
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
        });
        return () => observer.disconnect();
      },
      signal,
      "Documentation opened, but its search field is not ready.",
    );
    if (!signal.aborted && document.hasFocus()) search.focus();
    return;
  }
  if (destination.kind === "app-page") {
    redux.getActions("page").set_active_tab(destination.page, true);
    return;
  }
  const { projectId } = destination;
  const projectsStore: any = redux.getStore("projects");
  if (projectsStore?.is_project_open?.(projectId)) {
    // Only bring an open project to the front. open_project would also load
    // a default target (the home directory while the files page is active),
    // resetting the current directory and re-running open logic.
    if (redux.getStore("page")?.get("active_top_tab") !== projectId)
      await redux.getActions("page").set_active_tab(projectId, true);
  } else {
    await redux
      .getActions("projects")
      .open_project({ project_id: projectId, switch_to: true });
  }
  if (signal.aborted || destination.kind === "project") return;
  const project = redux.getProjectActions(projectId);
  if (destination.kind === "project-page") {
    activateProjectTab(project, destination.page, {
      flyout: destination.page,
      noFullPage: FIXED_PROJECT_TABS[destination.page]?.noFullPage,
    });
    return;
  }
  await project.open_file({ path: destination.path, foreground: true });
  if (signal.aborted) return;
  const projectStore = redux.getProjectStore(projectId);
  const component = await waitUntil(
    () => {
      const value = projectStore.getIn([
        "open_files",
        destination.path,
        "component",
      ]);
      const info = value?.toJS?.() ?? value;
      // Pure React viewers have no editor Redux actions to wait for.
      return info?.Editor &&
        (!info.redux_name || redux.getActions(info.redux_name))
        ? info
        : undefined;
    },
    storeChanges(projectStore),
    signal,
    "The editor has not finished opening. Try selecting it again.",
  );
  if (signal.aborted) return;
  const actions: any = component.redux_name
    ? redux.getActions(component.redux_name)
    : redux.getEditorActions(projectId, destination.path);
  if (!actions) return;
  let chosen: string | undefined = destination.frameId;
  if (destination.chat) {
    // Digit 0: focus the file's chat frame, opening the side chat first when
    // the layout has none. open_chat creates and activates the frame.
    chosen = actions._get_most_recent_active_frame_id_of_type?.("chat");
    if (!chosen) {
      project.open_chat({ path: destination.path });
      chosen = await waitUntil(
        () => actions._get_most_recent_active_frame_id_of_type?.("chat"),
        storeChanges(actions.store),
        signal,
        "The chat could not be opened. Try selecting it again.",
      );
      if (signal.aborted) return;
    }
  }
  const frameId: string | undefined =
    chosen ?? actions.store?.getIn(["local_view_state", "active_id"]);
  if (!frameId) return;
  const checkFrame = () => {
    if (actions._get_frame_node?.(frameId) == null)
      throw Error(
        "That frame has closed. Open Quick Navigation again to refresh the results.",
      );
  };
  checkFrame();
  actions.set_active_id(frameId, true);
  await waitUntil(
    () => {
      checkFrame();
      return frameRoot(frameId);
    },
    (check) => {
      document.addEventListener(FRAME_COMMIT_EVENT, check);
      const unsubscribe = storeChanges(actions.store)(check);
      return () => {
        document.removeEventListener(FRAME_COMMIT_EVENT, check);
        unsubscribe();
      };
    },
    signal,
    "The editor opened, but its frame is not visible. Try selecting it again.",
  );
  if (signal.aborted) return;
  if (actions._get_frame_node(frameId).get("type") === "cm") {
    const fileActions =
      actions.get_code_editor?.(frameId)?.get_actions() ?? actions;
    await waitUntil(
      () => fileActions._cm?.[frameId],
      storeChanges(fileActions.store, "cm-mounted"),
      signal,
      "The source editor has not finished mounting. Try selecting it again.",
    );
  }
  if (signal.aborted || !document.hasFocus()) return;
  checkFrame();
  // Focus is best effort. A competing focus call in the same tick (an
  // editor's own show/focus, a late autofocus) can undo ours, so try once
  // more on the next frame. If that fails too, leave the file open and its
  // frame active without bothering the user: a click fixes it, and asking
  // them to "try again" would not.
  if (focusFrame(actions, frameId)) return;
  await nextFrame();
  if (signal.aborted || !document.hasFocus()) return;
  checkFrame();
  if (!focusFrame(actions, frameId))
    logger.debug("focus handoff did not stick", {
      projectId,
      path: destination.path,
      frameId,
    });
}
