/*
A sortable vertical list of items.

This uses @dnd-kit for sorting and has support for the list
being virtualized with react-virtuoso.

- Use the SortableList component with your list of items inside of it.
- Use the SortableItem around each of your items
- You must use a DragHandle inside of each item.

*/

import {
  CSSProperties,
  ReactNode,
  createContext,
  useContext,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icon";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  restrictToVerticalAxis,
  restrictToFirstScrollableAncestor,
} from "@dnd-kit/modifiers";

interface Props {
  items: (string | number)[];
  Item?;
  children?: ReactNode;
  onDragStart?: (id) => void;
  onDragStop?: (oldIndex: number, newIndex: number) => void;
  onDragMove?: () => void;
  disabled?: boolean;
}

interface SortableHandleContextValue {
  id: string | number;
  attributes: Record<string, any>;
  listeners: Record<string, any> | undefined;
  setActivatorNodeRef?: (element: HTMLElement | null) => void;
}

const SortableHandleContext = createContext<SortableHandleContextValue | null>(
  null,
);

export function SortableList({
  items,
  Item,
  onDragStart,
  onDragStop,
  onDragMove,
  children,
  disabled,
}: Props) {
  function onDragEnd(event) {
    const { active, over } = event;
    setDragId(null);
    if (active != null && over == null) {
      // moved to the very top or bottom
      const oldIndex = items.indexOf(active.id);
      const newIndex = event.delta?.y < 0 ? 0 : items.length - 1;
      onDragStop?.(oldIndex, newIndex);
      return;
    }
    if (active == null || over == null || active.id == over.id) {
      return;
    }
    const oldIndex = items.indexOf(active.id);
    const newIndex = items.indexOf(over?.id);
    onDragStop?.(oldIndex, newIndex);
  }

  const [dragId, setDragId] = useState<string | null>(null);

  if (disabled) {
    return <>{children}</>;
  }

  return (
    <DndContext
      onDragStart={(event) => {
        setDragId(`${event.active.id}`);
        onDragStart?.(event.active.id);
      }}
      onDragEnd={onDragEnd}
      onDragMove={onDragMove}
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        {Item != null && (
          <>
            {typeof document !== "undefined" &&
              createPortal(
                <DragOverlay zIndex={50000}>
                  {dragId != null && <Item id={dragId} />}
                </DragOverlay>,
                document.body,
              )}
          </>
        )}
        {children}
      </SortableContext>
    </DndContext>
  );
}

export function SortableItem({
  id,
  children,
  hideActive = true,
}: {
  id: string | number;
  children: ReactNode;
  hideActive?: boolean;
}) {
  const {
    active,
    transform,
    transition,
    setNodeRef,
    attributes,
    listeners,
    setActivatorNodeRef,
  } = useSortable({
    id,
  });
  return (
    <SortableHandleContext.Provider
      value={{ id, attributes, listeners, setActivatorNodeRef }}
    >
      <div
        ref={setNodeRef}
        style={
          active != null
            ? {
                transform: transform
                  ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
                  : undefined,
                transition,
                opacity:
                  hideActive && active?.id == id
                    ? 0
                    : undefined /* render it invisible in case its the active one -- want the space it takes up*/,
              }
            : undefined
        }
      >
        {children}
      </div>
    </SortableHandleContext.Provider>
  );
}

export function DragHandle({
  id,
  children,
  style,
}: {
  id: string | number;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  const context = useContext(SortableHandleContext);
  if (context != null && context.id == id) {
    const { attributes, listeners, setActivatorNodeRef } = context;
    return (
      <div
        ref={setActivatorNodeRef}
        style={{
          display: "inline-block",
          cursor: "move",
          ...style,
        }}
        {...attributes}
        {...listeners}
      >
        {children ? children : <Icon name="bars" />}
      </div>
    );
  }

  return (
    <StandaloneDragHandle id={id} style={style}>
      {children}
    </StandaloneDragHandle>
  );
}

function StandaloneDragHandle({
  id,
  children,
  style,
}: {
  id: string | number;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  const { attributes, listeners, setActivatorNodeRef } = useSortable({ id });
  return (
    <div
      ref={setActivatorNodeRef}
      style={{
        display: "inline-block",
        cursor: "move",
        ...style,
      }}
      {...attributes}
      {...listeners}
    >
      {children ? children : <Icon name="bars" />}
    </div>
  );
}
