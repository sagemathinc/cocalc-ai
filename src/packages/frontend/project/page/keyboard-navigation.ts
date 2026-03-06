import { redux } from "@cocalc/frontend/app-framework";
import { KEYBOARD_BOUNDARY_ATTRIBUTE } from "@cocalc/frontend/keyboard/boundary";
import { EDITOR_PREFIX, path_to_tab, tab_to_path } from "@cocalc/util/misc";

export const PROJECT_PAGE_ATTRIBUTE = "data-cocalc-project-page";
export const FILE_TAB_STRIP_ATTRIBUTE = "data-cocalc-file-tab-strip";

const BEFORE_EDITOR_BOUNDARIES = new Set(["flyout"]);
const AFTER_EDITOR_BOUNDARIES = new Set(["dock", "side-chat"]);
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="tab"]',
  '[role="textbox"]',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

export type HostProfile = "browser" | "electron";

export type ProjectNavigationCommandId =
  | "focusNextFrame"
  | "focusPreviousFrame"
  | "activateNextFileTab"
  | "activatePreviousFileTab"
  | "focusFileTabStrip"
  | "focusCurrentFrameRoot";

interface NavigationBinding {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  hosts?: HostProfile[];
}

interface ProjectNavigationCommand {
  id: ProjectNavigationCommandId;
  bindings: NavigationBinding[];
}

export const PROJECT_NAVIGATION_COMMANDS: ReadonlyArray<ProjectNavigationCommand> =
  [
    {
      id: "focusNextFrame",
      bindings: [{ key: "F6" }],
    },
    {
      id: "focusPreviousFrame",
      bindings: [{ key: "F6", shift: true }],
    },
    {
      id: "activateNextFileTab",
      bindings: [
        { key: "F6", ctrl: true },
        { key: "Tab", ctrl: true, hosts: ["electron"] },
      ],
    },
    {
      id: "activatePreviousFileTab",
      bindings: [
        { key: "F6", ctrl: true, shift: true },
        { key: "Tab", ctrl: true, shift: true, hosts: ["electron"] },
      ],
    },
    {
      id: "focusFileTabStrip",
      bindings: [],
    },
    {
      id: "focusCurrentFrameRoot",
      bindings: [],
    },
  ] as const;

type ProjectNavigationActions = {
  activate_next_file_tab?: () => boolean;
  activate_previous_file_tab?: () => boolean;
  focus_file_tab_strip?: () => boolean;
};

type EditorNavigationActions = {
  focus?: () => void;
  get_active_frame_id?: () => string | undefined;
  get_frame_ids_in_order?: () => string[];
  set_active_id?: (id: string, ignore_if_missing?: boolean) => void;
};

export interface ProjectNavigationRuntime {
  activeProjectTab?: string;
  editorActions?: EditorNavigationActions;
  projectActions?: ProjectNavigationActions;
  projectRoot?: ParentNode | null;
}

interface ProjectNavigationRuntimeOptions {
  activeProjectTab?: string;
  editorActions?: EditorNavigationActions;
  projectActions?: ProjectNavigationActions;
  projectRoot?: ParentNode | null;
}

interface FocusTarget {
  id: string;
  contains: (element: Element | null) => boolean;
  focus: () => boolean;
}

function getHostProfile(): HostProfile {
  const anyGlobal = globalThis as typeof globalThis & {
    process?: { versions?: { electron?: string } };
    navigator?: { userAgent?: string };
  };
  if (anyGlobal.process?.versions?.electron != null) {
    return "electron";
  }
  if (anyGlobal.navigator?.userAgent?.includes("Electron")) {
    return "electron";
  }
  return "browser";
}

function bindingMatches(
  event: KeyboardEvent,
  binding: NavigationBinding,
  host: HostProfile,
): boolean {
  if (binding.hosts != null && !binding.hosts.includes(host)) {
    return false;
  }
  return (
    event.key === binding.key &&
    !!event.ctrlKey === !!binding.ctrl &&
    !!event.shiftKey === !!binding.shift &&
    !!event.altKey === !!binding.alt &&
    !!event.metaKey === !!binding.meta
  );
}

export function matchProjectNavigationCommand(
  event: KeyboardEvent,
  host: HostProfile = getHostProfile(),
): ProjectNavigationCommandId | undefined {
  for (const command of PROJECT_NAVIGATION_COMMANDS) {
    if (command.bindings.some((binding) => bindingMatches(event, binding, host))) {
      return command.id;
    }
  }
  return undefined;
}

export function getAdjacentOpenFilePath(
  openFiles: readonly string[],
  activeProjectTab: string | undefined,
  direction: 1 | -1,
): string | undefined {
  if (openFiles.length === 0) return;
  const activePath =
    typeof activeProjectTab === "string" && activeProjectTab.startsWith(EDITOR_PREFIX)
      ? tab_to_path(activeProjectTab)
      : undefined;
  let index = activePath != null ? openFiles.indexOf(activePath) : -1;
  if (index === -1) {
    index = direction > 0 ? -1 : 0;
  }
  const nextIndex = (index + direction + openFiles.length) % openFiles.length;
  return openFiles[nextIndex];
}

export function getProjectFileTabStrip(
  root: ParentNode | null | undefined,
): HTMLElement | null {
  if (root == null) return null;
  const strip = root.querySelector<HTMLElement>(`[${FILE_TAB_STRIP_ATTRIBUTE}]`);
  return strip instanceof HTMLElement ? strip : null;
}

function isVisibleElement(element: Element | null | undefined): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function focusElement(element: HTMLElement | null | undefined): boolean {
  if (!isVisibleElement(element)) return false;
  if (!element.hasAttribute("tabindex")) {
    element.setAttribute("tabindex", "-1");
  }
  element.focus();
  return document.activeElement === element;
}

function findActiveFileTabButton(strip: ParentNode): HTMLElement | null {
  return (
    strip.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
    strip.querySelector<HTMLElement>(".ant-tabs-tab-active [role='tab']") ??
    strip.querySelector<HTMLElement>(".ant-tabs-tab-active .ant-tabs-tab-btn") ??
    strip.querySelector<HTMLElement>('[role="tab"]')
  );
}

export function focusProjectFileTabStrip(
  root: ParentNode | null | undefined,
): boolean {
  const strip = getProjectFileTabStrip(root);
  if (strip == null) return false;
  return focusElement(findActiveFileTabButton(strip) ?? strip);
}

export function getProjectPageRoot(projectId: string): HTMLElement | null {
  const root = document.querySelector<HTMLElement>(
    `[${PROJECT_PAGE_ATTRIBUTE}="${projectId}"]`,
  );
  return root instanceof HTMLElement ? root : null;
}

function focusFirstFocusable(root: ParentNode | null | undefined): boolean {
  if (root == null) return false;
  const next =
    root.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ??
    (root instanceof HTMLElement ? root : null);
  return focusElement(next);
}

function getNavigationBoundaries(
  projectRoot: ParentNode | null | undefined,
  names: Set<string>,
): HTMLElement[] {
  if (projectRoot == null) return [];
  const candidates = Array.from(
    projectRoot.querySelectorAll<HTMLElement>(`[${KEYBOARD_BOUNDARY_ATTRIBUTE}]`),
  ).filter((element) => {
    const boundary = element.getAttribute(KEYBOARD_BOUNDARY_ATTRIBUTE) ?? "";
    return names.has(boundary) && isVisibleElement(element);
  });
  return candidates.filter(
    (element) =>
      !candidates.some((other) => other !== element && other.contains(element)),
  );
}

function buildEditorTargets(editorActions: EditorNavigationActions | undefined): FocusTarget[] {
  const frameIds = editorActions?.get_frame_ids_in_order?.() ?? [];
  if (frameIds.length === 0 || editorActions?.set_active_id == null) {
    return editorActions?.focus == null
      ? []
      : [
          {
            id: "editor:active",
            contains: () => false,
            focus: () => {
              editorActions.focus?.();
              return true;
            },
          },
        ];
  }
  return frameIds.map((frameId) => ({
    id: `editor:${frameId}`,
    contains: () => false,
    focus: () => {
      editorActions.set_active_id?.(frameId, true);
      return true;
    },
  }));
}

function buildBoundaryTargets(boundaries: HTMLElement[]): FocusTarget[] {
  return boundaries.map((boundary, index) => ({
    id: `boundary:${boundary.getAttribute(KEYBOARD_BOUNDARY_ATTRIBUTE) ?? index}`,
    contains: (element) => element != null && boundary.contains(element),
    focus: () => focusFirstFocusable(boundary),
  }));
}

function buildFocusTargets(runtime: ProjectNavigationRuntime): FocusTarget[] {
  const targets: FocusTarget[] = [];
  const beforeEditor = buildBoundaryTargets(
    getNavigationBoundaries(runtime.projectRoot, BEFORE_EDITOR_BOUNDARIES),
  );
  const afterEditor = buildBoundaryTargets(
    getNavigationBoundaries(runtime.projectRoot, AFTER_EDITOR_BOUNDARIES),
  );
  const strip = getProjectFileTabStrip(runtime.projectRoot);
  if (strip != null) {
    targets.push({
      id: "file-tab-strip",
      contains: (element) => element != null && strip.contains(element),
      focus: () => focusProjectFileTabStrip(runtime.projectRoot),
    });
  }
  targets.push(...beforeEditor);
  targets.push(...buildEditorTargets(runtime.editorActions));
  targets.push(...afterEditor);
  return targets;
}

function getCurrentTargetIndex(
  targets: FocusTarget[],
  runtime: ProjectNavigationRuntime,
): number {
  const activeElement =
    document.activeElement instanceof Element ? document.activeElement : null;
  const directIndex = targets.findIndex((target) => target.contains(activeElement));
  if (directIndex !== -1) {
    return directIndex;
  }
  const activeFrameId = runtime.editorActions?.get_active_frame_id?.();
  if (activeFrameId != null) {
    return targets.findIndex((target) => target.id === `editor:${activeFrameId}`);
  }
  return -1;
}

function focusAdjacentTarget(
  runtime: ProjectNavigationRuntime,
  direction: 1 | -1,
): boolean {
  const targets = buildFocusTargets(runtime);
  if (targets.length === 0) return false;
  const currentIndex = getCurrentTargetIndex(targets, runtime);
  const nextIndex =
    currentIndex === -1
      ? direction > 0
        ? 0
        : targets.length - 1
      : (currentIndex + direction + targets.length) % targets.length;
  return targets[nextIndex].focus();
}

export function runProjectNavigationCommand(
  command: ProjectNavigationCommandId,
  runtime: ProjectNavigationRuntime,
): boolean {
  const fileTabStripHasFocus =
    getProjectFileTabStrip(runtime.projectRoot)?.contains(
      document.activeElement instanceof Element ? document.activeElement : null,
    ) ?? false;
  switch (command) {
    case "focusNextFrame":
      return focusAdjacentTarget(runtime, 1);
    case "focusPreviousFrame":
      return focusAdjacentTarget(runtime, -1);
    case "activateNextFileTab": {
      const handled = runtime.projectActions?.activate_next_file_tab?.() ?? false;
      if (handled && fileTabStripHasFocus) {
        runtime.projectActions?.focus_file_tab_strip?.();
      }
      return handled;
    }
    case "activatePreviousFileTab": {
      const handled = runtime.projectActions?.activate_previous_file_tab?.() ?? false;
      if (handled && fileTabStripHasFocus) {
        runtime.projectActions?.focus_file_tab_strip?.();
      }
      return handled;
    }
    case "focusFileTabStrip":
      return runtime.projectActions?.focus_file_tab_strip?.() ?? false;
    case "focusCurrentFrameRoot":
      runtime.editorActions?.focus?.();
      return runtime.editorActions?.focus != null;
    default:
      return false;
  }
}

export function resolveProjectNavigationRuntime(
  projectId: string,
  opts: ProjectNavigationRuntimeOptions = {},
): ProjectNavigationRuntime {
  const store = redux.getProjectStore(projectId);
  const activeProjectTab = opts.activeProjectTab ?? store?.get("active_project_tab");
  const projectActions =
    opts.projectActions ?? ((redux.getProjectActions(projectId) as any) ?? undefined);
  const editorPath = getActiveEditorTabPath(activeProjectTab);
  const openFiles = store?.get("open_files");
  const syncPath =
    editorPath != null
      ? ((openFiles?.getIn([editorPath, "sync_path"]) as string | undefined) ??
        editorPath)
      : undefined;
  const editorActions =
    opts.editorActions ??
    (syncPath != null ? ((redux.getEditorActions(projectId, syncPath) as any) ?? undefined) : undefined);
  return {
    activeProjectTab,
    editorActions,
    projectActions,
    projectRoot: opts.projectRoot ?? getProjectPageRoot(projectId),
  };
}

export function runProjectNavigationCommandForProject(
  command: ProjectNavigationCommandId,
  projectId: string,
  opts: ProjectNavigationRuntimeOptions = {},
): boolean {
  return runProjectNavigationCommand(
    command,
    resolveProjectNavigationRuntime(projectId, opts),
  );
}

export function handleProjectNavigationKeydown(
  event: KeyboardEvent,
  projectId: string,
  opts: ProjectNavigationRuntimeOptions = {},
): boolean {
  if (event.defaultPrevented) return false;
  const command = matchProjectNavigationCommand(event);
  if (command == null) return false;
  const handled = runProjectNavigationCommandForProject(command, projectId, opts);
  if (!handled) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

export function getActiveEditorTabPath(activeProjectTab?: string): string | undefined {
  if (typeof activeProjectTab !== "string" || !activeProjectTab.startsWith(EDITOR_PREFIX)) {
    return;
  }
  return tab_to_path(activeProjectTab);
}

export function getFileTabKey(path: string): string {
  return path_to_tab(path);
}
