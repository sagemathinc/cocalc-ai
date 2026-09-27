/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Alert, Button } from "antd";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  Collection,
  CollectionViewControl,
} from "@cocalc/frontend/components/collection";
import { moveVisibleCollectionPin } from "@cocalc/frontend/components/collection-order";
import { useCollectionPreferences } from "@cocalc/frontend/components/use-collection-preferences";

/** Adapt existing favorite/collected writes; people use account preferences. */
export function DirectoryCollection<T>({
  items,
  collection,
  label,
  itemId,
  itemTitle,
  renderItem,
  isPinned,
  onPin,
  pinLabel,
  itemStyle,
}: {
  items: T[];
  collection: "people" | "projects" | "conversations";
  label: string;
  itemId: (item: T) => string;
  itemTitle: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  isPinned?: (item: T) => boolean;
  onPin?: (item: T, pinned: boolean) => Promise<void>;
  pinLabel?: (item: T) => string;
  itemStyle?: (item: T) => CSSProperties;
}) {
  const prefs = useCollectionPreferences(collection);
  const [error, setError] = useState("");
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const pending = useRef(new Set<string>());
  const [overrides, setOverrides] = useState<
    Record<string, { item: T; pinned: boolean }>
  >({});
  const pinState = (item: T) => {
    const id = itemId(item);
    return overrides[id]?.item === item
      ? overrides[id].pinned
      : (isPinned?.(item) ?? prefs.value.order.includes(id));
  };
  const visiblePins = items.filter(pinState).map(itemId);
  // Orders may include hidden IDs; do not delete them when paging or filtering.
  const order = [
    ...prefs.value.order,
    ...visiblePins.filter((id) => !prefs.value.order.includes(id)),
  ];
  const pins = order.filter((id) => visiblePins.includes(id));
  async function toggle(item: T, pinned: boolean) {
    const id = itemId(item);
    if (pending.current.has(id)) return;
    setError("");
    if (!onPin) {
      prefs.setOrder(
        pinned
          ? [...order.filter((value) => value !== id), id]
          : order.filter((value) => value !== id),
      );
      return;
    }
    pending.current.add(id);
    setBusyIds([...pending.current]);
    try {
      await onPin(item, pinned);
      setOverrides((values) => ({ ...values, [id]: { item, pinned } }));
    } catch (error) {
      setError(`Unable to save pin: ${String(error)}`);
    } finally {
      pending.current.delete(id);
      setBusyIds([...pending.current]);
    }
  }
  return (
    <div className="collaborators-list">
      <div className="collaborators-actions">
        <CollectionViewControl
          view={prefs.value.view}
          onChange={prefs.setView}
          label={label}
        />
        <small>
          Pins are ordered within this page and filters. Drag to reorder, or
          focus a drag handle and use Space and the arrow keys.
        </small>
      </div>
      {prefs.error && (
        <Alert
          role="alert"
          type="error"
          title={prefs.error}
          action={<Button onClick={prefs.retry}>Retry save</Button>}
        />
      )}
      {error && <Alert role="alert" type="error" title={error} />}
      <Collection
        items={items}
        itemId={itemId}
        itemTitle={itemTitle}
        pins={pins}
        view={prefs.value.view}
        otherTitle={`Other ${label.toLowerCase()}`}
        pinLabel={pinLabel}
        busyIds={busyIds}
        onPin={(item, value) => void toggle(item, value)}
        onMove={(visible, id, index) =>
          prefs.setOrder(moveVisibleCollectionPin(order, visible, id, index))
        }
        renderItem={(item, controls) => (
          <div
            style={{
              display: "flex",
              flexDirection: prefs.value.view === "grid" ? "column" : "row",
              alignItems: "center",
              border: `1px solid ${UI_COLORS.border}`,
              borderRadius: 8,
              background: UI_COLORS.surface,
              color: UI_COLORS.text,
              marginBottom: 8,
              minWidth: 0,
              ...itemStyle?.(item),
            }}
          >
            <div style={{ flex: 1, width: "100%", minWidth: 0 }}>
              {renderItem(item)}
            </div>
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              {controls.dragHandle}
              {controls.pinButton}
              {collection !== "people" && controls.orderMenu}
            </div>
          </div>
        )}
      />
    </div>
  );
}
