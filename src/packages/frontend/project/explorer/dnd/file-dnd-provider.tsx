/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  DragEndEvent,
  DragMoveEvent,
  DragOverEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import React, { useCallback, useEffect, useRef, useState } from "react";

import {
  DRAG_OVERLAY_MODIFIERS,
  DragOverlayContent,
  MOUSE_SENSOR_OPTIONS,
  TOUCH_SENSOR_OPTIONS,
  getEventCoords,
} from "@cocalc/frontend/components/dnd";
import {
  redux,
  useActions,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { path_split, plural, uuid } from "@cocalc/util/misc";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";

export interface FileDragData {
  type: "file-drag";
  paths: string[];
  project_id: string;
}

export interface FolderDropData {
  type: "folder-drop";
  path: string;
}

export function useFileDrag(id: string, paths: string[], project_id: string) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    data: { type: "file-drag", paths, project_id } satisfies FileDragData,
  });
  return {
    dragRef: setNodeRef,
    dragListeners: listeners,
    dragAttributes: attributes,
    isDragging,
  };
}

export function useFolderDrop(id: string, folderPath: string, enabled = true) {
  const { setNodeRef, isOver, active } = useDroppable({
    id,
    disabled: !enabled,
    data: { type: "folder-drop", path: folderPath } satisfies FolderDropData,
  });
  const dragData = active?.data?.current as FileDragData | undefined;
  const isDragging = dragData?.type === "file-drag";
  const isSelfDrop =
    isDragging &&
    dragData.paths.some(
      (path) => path === folderPath || folderPath.startsWith(path + "/"),
    );
  const isAlreadyInFolder =
    isDragging &&
    !isSelfDrop &&
    dragData.paths.every((path) => path_split(path).head === folderPath);
  const isInvalid = isSelfDrop || isAlreadyInFolder;
  return {
    dropRef: setNodeRef,
    isOver: isOver && enabled && isDragging && !isInvalid,
    isInvalidDrop: isOver && isInvalid,
  };
}

export function findFolderDropPathAtPoint(x: number, y: number): string | null {
  const elements = document.elementsFromPoint(x, y);
  for (const element of elements) {
    const folderPath = (element as HTMLElement).getAttribute?.(
      "data-folder-drop-path",
    );
    if (folderPath != null) {
      return folderPath;
    }
  }
  return null;
}

function findProjectTabAtPoint(
  x: number,
  y: number,
  sourceProjectId: string,
): string | null {
  const elements = document.elementsFromPoint(x, y);
  for (const element of elements) {
    const nodeKey = (element as HTMLElement).getAttribute?.("data-node-key");
    if (nodeKey && nodeKey !== sourceProjectId) {
      return nodeKey;
    }
    const parentKey = element.parentElement?.getAttribute?.("data-node-key");
    if (parentKey && parentKey !== sourceProjectId) {
      return parentKey;
    }
  }
  return null;
}

function FileDragOverlay({
  data,
  isCopy,
  overFolder,
  isInvalid,
}: {
  data: FileDragData;
  isCopy: boolean;
  overFolder: string | null;
  isInvalid: boolean;
}) {
  const n = data.paths.length;
  if (isInvalid && overFolder != null) {
    const folderName = path_split(overFolder).tail || "Home";
    return (
      <DragOverlayContent
        icon="times-circle"
        text={`Cannot move into ${folderName}`}
        variant="invalid"
      />
    );
  }
  if (overFolder != null) {
    const target = path_split(overFolder).tail || "Home";
    return (
      <DragOverlayContent
        icon={isCopy ? "copy" : "arrow-right"}
        text={`${isCopy ? "Copy" : "Move"} ${n} ${plural(n, "file")} -> ${target}`}
        variant="valid"
      />
    );
  }
  return (
    <DragOverlayContent
      icon={isCopy ? "copy" : "arrows"}
      text={`${isCopy ? "Copy" : "Move"} ${n} ${plural(n, "file")} onto a folder`}
      variant="neutral"
    />
  );
}

export function FileDndProvider({
  project_id,
  onUserFilesystemChange,
  children,
}: {
  project_id: string;
  onUserFilesystemChange?: () => void;
  children: React.ReactNode;
}) {
  const actions = useActions({ project_id });
  const checked_files = useTypedRedux({ project_id }, "checked_files");
  const [activeData, setActiveData] = useState<FileDragData | null>(null);
  const [shiftKey, setShiftKey] = useState(false);
  const [overFolder, setOverFolder] = useState<string | null>(null);
  const [isInvalidTarget, setIsInvalidTarget] = useState(false);
  const isInvalidTargetRef = useRef(false);
  const pointerPos = useRef({ x: 0, y: 0 });
  const preDragCheckedRef = useRef<string[] | null>(null);
  const forceCancelledRef = useRef(false);
  const lastMoveCheck = useRef(0);

  const sensors = useSensors(
    useSensor(MouseSensor, MOUSE_SENSOR_OPTIONS),
    useSensor(TouchSensor, TOUCH_SENSOR_OPTIONS),
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift") setShiftKey(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") setShiftKey(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useEffect(() => {
    if (!activeData) return;
    const move = (event: PointerEvent) => {
      pointerPos.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, [activeData]);

  useEffect(() => {
    return () => {
      document.body.style.cursor = "";
      document.body.classList.remove("cc-file-dragging");
    };
  }, []);

  useEffect(() => {
    isInvalidTargetRef.current = isInvalidTarget;
  }, [isInvalidTarget]);

  const restoreSelection = useCallback(() => {
    if (preDragCheckedRef.current == null) return;
    const saved = preDragCheckedRef.current;
    preDragCheckedRef.current = null;
    actions?.set_all_files_unchecked();
    if (saved.length > 0) {
      actions?.set_file_list_checked(saved);
    }
  }, [actions]);

  useEffect(() => {
    if (!activeData) return;

    const cancelDrag = () => {
      forceCancelledRef.current = true;
      setActiveData(null);
      setOverFolder(null);
      setIsInvalidTarget(false);
      document.body.style.cursor = "";
      document.body.classList.remove("cc-file-dragging");
      restoreSelection();
    };

    const onVisibility = () => {
      if (document.hidden) {
        cancelDrag();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", cancelDrag);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", cancelDrag);
    };
  }, [activeData, restoreSelection]);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const data = event.active.data.current as FileDragData | undefined;
      if (data?.type !== "file-drag") return;
      forceCancelledRef.current = false;
      const coords = getEventCoords(event.activatorEvent);
      if (coords) {
        pointerPos.current = coords;
      }
      preDragCheckedRef.current = checked_files?.toArray() ?? [];
      actions?.set_file_list_checked(data.paths);
      setActiveData(data);
      document.body.style.cursor = "grabbing";
      document.body.classList.add("cc-file-dragging");
    },
    [actions, checked_files],
  );

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const dropData = event.over?.data?.current as FolderDropData | undefined;
    const dragData = event.active?.data?.current as FileDragData | undefined;
    if (dropData?.type === "folder-drop" && dragData?.paths) {
      const isSelf = dragData.paths.some(
        (path) =>
          path === dropData.path || dropData.path.startsWith(path + "/"),
      );
      const isAlreadyIn = dragData.paths.every(
        (path) => path_split(path).head === dropData.path,
      );
      if (isAlreadyIn && !isSelf) {
        setOverFolder(null);
        setIsInvalidTarget(false);
      } else {
        setOverFolder(dropData.path);
        setIsInvalidTarget(isSelf);
      }
    } else {
      setOverFolder(null);
      setIsInvalidTarget(false);
    }
  }, []);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    if (event.over != null) return;
    const now = Date.now();
    if (now - lastMoveCheck.current < 80) return;
    lastMoveCheck.current = now;
    const { x, y } = pointerPos.current;
    const element = document.elementFromPoint(x, y);
    if (!element) return;
    const folderPath = findFolderDropPathAtPoint(x, y);
    if (folderPath != null) {
      setOverFolder(folderPath);
      return;
    }
    const row = element.closest?.("[data-row-key], [data-folder-drop-path]");
    if (row && !row.hasAttribute("data-folder-drop-path")) {
      setOverFolder(null);
      setIsInvalidTarget(false);
    } else if (isInvalidTargetRef.current) {
      setOverFolder(null);
      setIsInvalidTarget(false);
    }
  }, []);

  const handleDragCancel = useCallback(() => {
    setActiveData(null);
    setOverFolder(null);
    setIsInvalidTarget(false);
    document.body.style.cursor = "";
    document.body.classList.remove("cc-file-dragging");
    restoreSelection();
  }, [restoreSelection]);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveData(null);
      setOverFolder(null);
      setIsInvalidTarget(false);
      document.body.style.cursor = "";
      document.body.classList.remove("cc-file-dragging");

      if (forceCancelledRef.current) {
        forceCancelledRef.current = false;
        restoreSelection();
        return;
      }

      const dragData = event.active.data.current as FileDragData | undefined;
      if (!dragData || !actions) {
        restoreSelection();
        return;
      }

      const dropData = event.over?.data?.current as FolderDropData | undefined;
      if (dropData?.type === "folder-drop") {
        if (
          dragData.paths.some(
            (path) =>
              path === dropData.path || dropData.path.startsWith(path + "/"),
          ) ||
          dragData.paths.every(
            (path) => path_split(path).head === dropData.path,
          )
        ) {
          restoreSelection();
          return;
        }
        try {
          if (shiftKey) {
            await actions.copyPaths({
              src: dragData.paths,
              dest: dropData.path,
            });
          } else {
            await actions.moveFiles({
              src: dragData.paths,
              dest: dropData.path,
            });
          }
          onUserFilesystemChange?.();
          actions.set_all_files_unchecked();
          preDragCheckedRef.current = null;
        } catch (err) {
          actions.set_activity({
            id: uuid(),
            error: `Drag-and-drop failed: ${err}`,
          });
          restoreSelection();
        }
        return;
      }

      const { x, y } = pointerPos.current;
      const targetProjectId = findProjectTabAtPoint(x, y, project_id);
      if (targetProjectId) {
        try {
          const targetStore = redux.getProjectStore(targetProjectId);
          const destPath =
            targetStore?.get("current_path_abs") ??
            getProjectHomeDirectory(targetProjectId);
          await actions.copyPathBetweenProjects({
            src: { project_id, path: dragData.paths },
            dest: { project_id: targetProjectId, path: destPath },
          });
          onUserFilesystemChange?.();
          actions.set_all_files_unchecked();
          preDragCheckedRef.current = null;
          return;
        } catch (err) {
          actions.set_activity({
            id: uuid(),
            error: `Cross-project copy failed: ${err}`,
          });
        }
      }

      restoreSelection();
    },
    [actions, onUserFilesystemChange, project_id, restoreSelection, shiftKey],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {children}
      <DragOverlay dropAnimation={null} modifiers={DRAG_OVERLAY_MODIFIERS}>
        {activeData ? (
          <FileDragOverlay
            data={activeData}
            isCopy={shiftKey}
            overFolder={overFolder}
            isInvalid={isInvalidTarget}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
