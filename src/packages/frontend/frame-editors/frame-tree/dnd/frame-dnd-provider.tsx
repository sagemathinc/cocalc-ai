/*
 *  This file is part of CoCalc: Copyright © 2020-2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import {
  MOUSE_SENSOR_OPTIONS,
  TOUCH_SENSOR_OPTIONS,
  DRAG_OVERLAY_MODIFIERS,
  DragOverlayContent,
} from "@cocalc/frontend/components/dnd";
import type { IconName } from "@cocalc/frontend/components/icon";
import { Actions } from "../../code-editor/actions";
import type { DropZone } from "./use-frame-drop-zone";

export interface FrameDragData {
  type: "frame-drag";
  frameId: string;
  frameType: string;
  frameLabel: string;
}

export type DropPosition = "top" | "bottom" | "left" | "right" | "tab";

function isEdgeZone(
  zone: DropZone,
): zone is "top" | "bottom" | "left" | "right" {
  return (
    zone === "top" || zone === "bottom" || zone === "left" || zone === "right"
  );
}

export function shouldExtractTabFromDrop(
  sourceId: string,
  zone: DropZone,
  overData?: {
    tabContainerId?: string | null;
    tabChildIds?: string[];
  } | null,
): boolean {
  return (
    isEdgeZone(zone) &&
    overData?.tabContainerId != null &&
    overData.tabChildIds?.includes(sourceId) === true
  );
}

export const FrameDndZoneContext = React.createContext<{
  setDropZone: (frameId: string, zone: DropZone) => void;
}>({
  setDropZone: () => {},
});

const ZONE_ICONS: Record<string, IconName> = {
  center: "exchange",
  top: "arrow-up",
  bottom: "arrow-down",
  left: "arrow-left",
  right: "arrow-right",
  tab: "window-restore",
};

interface Props {
  actions: Actions;
  children: React.ReactNode;
}

export function FrameDndProvider({ actions, children }: Props) {
  const intl = useIntl();

  const zoneLabels: Record<string, string> = useMemo(
    () => ({
      center: intl.formatMessage({
        id: "frame-editors.frame-tree.dnd.zone.center",
        defaultMessage: "Swap",
      }),
      top: intl.formatMessage({
        id: "frame-editors.frame-tree.dnd.zone.top",
        defaultMessage: "Split above",
      }),
      bottom: intl.formatMessage({
        id: "frame-editors.frame-tree.dnd.zone.bottom",
        defaultMessage: "Split below",
      }),
      left: intl.formatMessage({
        id: "frame-editors.frame-tree.dnd.zone.left",
        defaultMessage: "Split left of",
      }),
      right: intl.formatMessage({
        id: "frame-editors.frame-tree.dnd.zone.right",
        defaultMessage: "Split right of",
      }),
      tab: intl.formatMessage({
        id: "frame-editors.frame-tree.dnd.zone.tab",
        defaultMessage: "Tab with",
      }),
    }),
    [intl],
  );

  const [activeData, setActiveData] = useState<FrameDragData | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [isSelfHover, setIsSelfHover] = useState(false);
  const [selfHoverTabContainerId, setSelfHoverTabContainerId] = useState<
    string | null
  >(null);
  const [dropAction, setDropAction] = useState<string>("");
  const [dropIcon, setDropIcon] = useState<IconName>("exchange");
  const [currentZone, setCurrentZone] = useState<DropZone>(null);

  const dropZoneRef = useRef<{ frameId: string; zone: DropZone } | null>(null);

  const setDropZone = useCallback(
    (frameId: string, zone: DropZone) => {
      if (zone === null) {
        if (dropZoneRef.current?.frameId === frameId) {
          dropZoneRef.current = null;
          setCurrentZone(null);
        }
      } else {
        const prev = dropZoneRef.current;
        if (prev?.frameId === frameId && prev.zone === zone) return;
        dropZoneRef.current = { frameId, zone };
        setCurrentZone(zone);
        setDropAction(zoneLabels[zone] || zoneLabels.center);
        setDropIcon(ZONE_ICONS[zone] || "exchange");
      }
    },
    [zoneLabels],
  );

  const sensors = useSensors(
    useSensor(MouseSensor, MOUSE_SENSOR_OPTIONS),
    useSensor(TouchSensor, TOUCH_SENSOR_OPTIONS),
  );

  const activeDataRef = useRef<FrameDragData | null>(null);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as FrameDragData;
    if (data?.type === "frame-drag") {
      setActiveData(data);
      activeDataRef.current = data;
      document.body.classList.add("cc-frame-dragging");
    }
  }, []);

  const handleDragOver = useCallback(
    (event) => {
      const overData = event.over?.data?.current;

      if (overData?.type === "tab-reorder-drop") {
        const sourceId = activeDataRef.current?.frameId;
        const isSibling =
          sourceId &&
          overData.childIds?.includes(sourceId) &&
          sourceId !== overData.frameId;
        if (isSibling) {
          setIsSelfHover(true);
          setSelfHoverTabContainerId(null);
          setDropTarget(null);
        } else if (sourceId && !overData.childIds?.includes(sourceId)) {
          setIsSelfHover(false);
          setSelfHoverTabContainerId(null);
          setDropTarget(overData.frameLabel || "Tabs");
          setDropAction(zoneLabels.tab);
          setDropIcon(ZONE_ICONS.tab);
          setCurrentZone("tab");
        } else {
          setIsSelfHover(true);
          setSelfHoverTabContainerId(null);
          setDropTarget(null);
        }
        return;
      }

      if (overData?.type === "tab-bar-drop") {
        const alreadyInTabs = overData.childIds?.includes(
          activeDataRef.current?.frameId,
        );
        if (alreadyInTabs) {
          setIsSelfHover(true);
          setSelfHoverTabContainerId(null);
          setDropTarget(null);
        } else {
          setIsSelfHover(false);
          setSelfHoverTabContainerId(null);
          setDropTarget(overData.frameLabel || "Tabs");
          setDropAction(zoneLabels.tab);
          setDropIcon(ZONE_ICONS.tab);
          setCurrentZone("tab");
        }
        return;
      }

      if (overData?.type === "frame-drop" && overData.frameLabel) {
        const sourceId = activeDataRef.current?.frameId;
        const isSelf = overData.frameId === sourceId;
        const isSameTabContainer =
          !!sourceId && overData.tabChildIds?.includes(sourceId);
        setIsSelfHover(isSelf || isSameTabContainer);
        if (isSelf || isSameTabContainer) {
          setSelfHoverTabContainerId(overData.tabContainerId ?? null);
          setDropTarget(null);
        } else {
          setSelfHoverTabContainerId(null);
          setDropTarget(overData.frameLabel);
        }
      } else {
        setDropTarget(null);
        setIsSelfHover(false);
        setSelfHoverTabContainerId(null);
      }
    },
    [zoneLabels.tab],
  );

  const resetDragState = useCallback(() => {
    document.body.classList.remove("cc-frame-dragging");
    setActiveData(null);
    activeDataRef.current = null;
    setDropTarget(null);
    setIsSelfHover(false);
    setSelfHoverTabContainerId(null);
    setCurrentZone(null);
    dropZoneRef.current = null;
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const data = activeData;
      const savedZoneInfo = dropZoneRef.current;
      resetDragState();

      if (!data || !event.over) return;

      const overData = event.over.data.current;
      if (!overData) return;

      const sourceId = data.frameId;

      if (overData.type === "tab-reorder-drop") {
        const { tabsId, frameId: targetFrameId, childIds } = overData;
        if (childIds?.includes(sourceId) && sourceId !== targetFrameId) {
          actions.reorder_tab(tabsId, sourceId, targetFrameId);
        } else if (!childIds?.includes(sourceId)) {
          const firstChildId = childIds?.[0];
          if (firstChildId) {
            actions.move_frame(sourceId, firstChildId, "tab");
          }
        }
        return;
      }

      if (overData.type === "tab-bar-drop") {
        const { tabsId, childIds } = overData;
        if (childIds?.includes(sourceId)) {
          actions.reorder_tab(tabsId, sourceId, null);
        } else {
          const targetId = childIds?.[0];
          if (targetId) {
            actions.move_frame(sourceId, targetId, "tab");
          }
        }
        return;
      }

      const targetId = overData.frameId;
      const zoneInfo = savedZoneInfo;
      const zone =
        zoneInfo?.frameId === targetId ? zoneInfo?.zone || "center" : "center";

      if (sourceId === targetId) {
        if (shouldExtractTabFromDrop(sourceId, zone, overData)) {
          actions.extract_tab(sourceId, zone);
        }
        return;
      }

      if (zone === "center") {
        actions.swap_frames(sourceId, targetId);
      } else if (zone === "tab") {
        actions.move_frame(sourceId, targetId, "tab");
      } else {
        if (shouldExtractTabFromDrop(sourceId, zone, overData)) {
          actions.extract_tab(sourceId, zone);
          return;
        }
        const splitTargetId =
          overData.tabContainerId && !selfHoverTabContainerId
            ? overData.tabContainerId
            : targetId;
        actions.move_frame(sourceId, splitTargetId, zone as DropPosition);
      }
    },
    [activeData, actions, resetDragState, selfHoverTabContainerId],
  );

  const handleDragCancel = useCallback(() => {
    resetDragState();
  }, [resetDragState]);

  const overlayText = activeData
    ? isSelfHover
      ? currentZone && selfHoverTabContainerId
        ? `${zoneLabels[currentZone] || zoneLabels.center} ${dropTarget ?? "tab group"}`
        : activeData.frameLabel
      : dropTarget
        ? `${dropAction} ${dropTarget}`
        : activeData.frameLabel
    : "";

  const overlayVariant = isSelfHover
    ? "neutral"
    : dropTarget
      ? "valid"
      : "neutral";

  return (
    <FrameDndZoneContext.Provider value={{ setDropZone }}>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {children}
        <DragOverlay modifiers={DRAG_OVERLAY_MODIFIERS}>
          {activeData ? (
            <DragOverlayContent
              icon={dropIcon}
              text={overlayText}
              variant={overlayVariant}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
    </FrameDndZoneContext.Provider>
  );
}
