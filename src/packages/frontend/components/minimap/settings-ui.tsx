/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Shared UI for configuring a minimap: the settings modal and the right-click
context menu.  Both are driven by a `MinimapSettingsApi`, so the notebook and
code-editor minimaps get identical controls while keeping their own persisted
preferences.
*/

import type { MenuProps } from "antd";
import {
  Button,
  Dropdown,
  InputNumber,
  Modal,
  Segmented,
  Slider,
  Space,
  Switch,
} from "antd";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { COLORS } from "@cocalc/util/theme";
import { Icon } from "@cocalc/frontend/components/icon";
import type {
  MinimapKind,
  MinimapSettings,
  MinimapSettingsApi,
} from "./settings";
import { MINIMAP_KINDS, useMinimapSettings } from "./settings";

// Only one settings modal at a time, even when several editor panes each
// mount a minimap that listens for the same "open settings" event.
const modalOwners = new Map<string, symbol>();

function claimModal(event: string, owner: symbol): boolean {
  const current = modalOwners.get(event);
  if (current == null || current === owner) {
    modalOwners.set(event, owner);
    return true;
  }
  return false;
}

function releaseModal(event: string, owner: symbol): void {
  if (modalOwners.get(event) === owner) modalOwners.delete(event);
}

export interface MinimapLabels {
  // e.g. "Notebook Minimap" / "Code Minimap"
  title: string;
}

const DEFAULT_LABELS: MinimapLabels = { title: "Minimap" };

// "Text" draws the document's actual characters; "Stylized" draws an outline of
// its blocks (notebook cells, paragraphs).
const KIND_LABELS: Record<MinimapKind, string> = {
  text: "Text",
  stylized: "Stylized",
};

const KIND_OPTIONS = MINIMAP_KINDS.map((value) => ({
  label: KIND_LABELS[value],
  value,
}));

type MinimapSettingsDraft = Omit<MinimapSettings, "width">;

function settingsDraft(settings: MinimapSettings): MinimapSettingsDraft {
  return {
    enabled: settings.enabled,
    kind: settings.kind,
    widths: { ...settings.widths },
  };
}

/**
 * Settings modal wired to the api's "open settings" window event.  Render the
 * returned node somewhere stable in the editor.  `isActive` lets an editor
 * with several frames restrict the dialog to the focused one.
 */
export function useMinimapSettingsModal({
  api,
  labels = DEFAULT_LABELS,
  isActive = true,
}: {
  api: MinimapSettingsApi;
  labels?: MinimapLabels;
  isActive?: boolean;
}): { modal: React.JSX.Element; open: () => void } {
  const settings = useMinimapSettings(api);
  const [show, setShow] = useState<boolean>(false);
  const [draft, setDraft] = useState<MinimapSettingsDraft>(() =>
    settingsDraft(settings),
  );
  const ownerRef = useRef<symbol>(Symbol("minimap-settings-modal"));
  const isActiveRef = useRef<boolean>(isActive);
  isActiveRef.current = isActive;

  const open = useCallback(() => {
    if (!isActiveRef.current) return;
    if (!claimModal(api.spec.openSettingsEvent, ownerRef.current)) return;
    setDraft(settingsDraft(api.read()));
    setShow(true);
  }, [api]);

  const close = useCallback(() => {
    releaseModal(api.spec.openSettingsEvent, ownerRef.current);
    setShow(false);
  }, [api]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const owner = ownerRef.current;
    window.addEventListener(api.spec.openSettingsEvent, open);
    return () => {
      window.removeEventListener(api.spec.openSettingsEvent, open);
      releaseModal(api.spec.openSettingsEvent, owner);
    };
  }, [api, open]);

  useEffect(() => {
    if (show) return;
    setDraft(settingsDraft(settings));
  }, [settings, show]);

  const apply = () => {
    api.setEnabled(draft.enabled);
    // The dialog lets you edit either style's width before applying — it keeps
    // both in `draft.widths` — so write both, not just the active one.
    for (const kind of MINIMAP_KINDS) {
      api.setWidth(draft.widths[kind], kind);
    }
    api.setKind(draft.kind);
    close();
  };

  // Keep the per-kind widths in sync, so switching style in the dialog does
  // not throw away an unsaved width edit for the style being left.
  const setDraftWidth = (width: number, kind: MinimapKind) =>
    setDraft((current) => ({
      ...current,
      widths: { ...current.widths, [kind]: width },
    }));

  const modal = (
    <Modal
      title={labels.title}
      open={show}
      okText="Apply"
      onOk={apply}
      onCancel={close}
    >
      <div style={{ display: "grid", rowGap: "14px" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span id="minimap-settings-enabled-label">Show minimap</span>
          <Switch
            aria-labelledby="minimap-settings-enabled-label"
            checked={draft.enabled}
            onChange={(enabled) =>
              setDraft((current) => ({ ...current, enabled }))
            }
          />
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span id="minimap-settings-style-label">Style</span>
          <Segmented
            aria-labelledby="minimap-settings-style-label"
            options={KIND_OPTIONS}
            value={draft.kind}
            onChange={(kind) =>
              setDraft((current) => ({
                ...current,
                kind: kind as MinimapKind,
              }))
            }
          />
        </div>
        {MINIMAP_KINDS.map((kind) => {
          const label = KIND_LABELS[kind];
          const labelId = `minimap-settings-${kind}-width-label`;
          const active = draft.kind === kind;
          const range = api.spec.widths[kind];
          return (
            <div
              key={kind}
              style={{
                display: "grid",
                rowGap: "8px",
                padding: "8px",
                borderRadius: "6px",
                background: active ? COLORS.ANTD_BG_BLUE_L : undefined,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span>
                  <span id={labelId}>{label} minimap width</span>
                  {active && (
                    <span style={{ color: COLORS.GRAY_M }}>
                      {" "}
                      (selected style)
                    </span>
                  )}
                </span>
                <Space size="small">
                  <InputNumber
                    aria-labelledby={labelId}
                    min={range.min}
                    max={range.max}
                    value={draft.widths[kind]}
                    disabled={!active}
                    onChange={(value) => {
                      if (
                        typeof value !== "number" ||
                        !Number.isFinite(value)
                      ) {
                        return;
                      }
                      setDraftWidth(api.clampWidth(value, kind), kind);
                    }}
                  />
                  <Button
                    size="small"
                    aria-label={`Reset ${label} minimap width to ${range.default} pixels`}
                    disabled={!active || draft.widths[kind] === range.default}
                    onClick={() => setDraftWidth(range.default, kind)}
                  >
                    Reset
                  </Button>
                </Space>
              </div>
              <Slider
                ariaLabelForHandle={`${label} minimap width`}
                min={range.min}
                max={range.max}
                value={draft.widths[kind]}
                disabled={!active}
                marks={{ [range.default]: `${range.default} px` }}
                onChange={(value) =>
                  setDraftWidth(api.clampWidth(Number(value), kind), kind)
                }
              />
            </div>
          );
        })}
      </div>
    </Modal>
  );

  return { modal, open };
}

/**
 * Menu entries shared by the minimap's right-click menu and its ⋮ button.
 */
export function useMinimapMenuItems({
  api,
  labels = DEFAULT_LABELS,
  onOpenSettings,
}: {
  api: MinimapSettingsApi;
  labels?: MinimapLabels;
  onOpenSettings?: () => void;
}): MenuProps["items"] {
  const settings = useMinimapSettings(api);
  return useMemo(() => {
    // Rows the user is expected to click repeatedly (the style switch, the
    // width steppers) swallow the click so the menu stays open.
    const keepOpen = (e: React.MouseEvent) => e.stopPropagation();
    const rowStyle: React.CSSProperties = {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "2px 0",
    };
    const labelStyle: React.CSSProperties = {
      color: COLORS.GRAY_M,
      minWidth: "3.5em",
    };
    // Each kind has its own width, so the step is relative to its range.
    const range = api.spec.widths[settings.kind];
    const step = Math.max(4, Math.round((range.max - range.min) / 16));
    return [
      {
        key: "kind",
        label: (
          <div style={rowStyle} onClick={keepOpen}>
            <span style={labelStyle}>Type</span>
            <Segmented
              size="small"
              options={KIND_OPTIONS}
              value={settings.kind}
              onChange={(kind) => api.setKind(kind as MinimapKind)}
            />
          </div>
        ),
      },
      {
        key: "width",
        label: (
          <div style={rowStyle} onClick={keepOpen}>
            <span style={labelStyle}>Width</span>
            <Space.Compact>
              <Button
                size="small"
                aria-label="Narrower minimap"
                title="Narrower"
                icon={<Icon name="minus" />}
                disabled={settings.width <= range.min}
                onClick={() => api.adjustWidth(-step)}
              />
              <Button
                size="small"
                aria-label="Wider minimap"
                title="Wider"
                icon={<Icon name="plus" />}
                disabled={settings.width >= range.max}
                onClick={() => api.adjustWidth(step)}
              />
            </Space.Compact>
            <span style={{ color: COLORS.GRAY_M }}>{settings.width}px</span>
          </div>
        ),
      },
      { type: "divider" as const },
      {
        key: "settings",
        label: `${labels.title} Settings...`,
        icon: <Icon name="gear" />,
        onClick: () => {
          if (onOpenSettings != null) {
            onOpenSettings();
          } else {
            api.openSettingsDialog();
          }
        },
      },
      {
        key: "hide",
        label: "Hide Minimap",
        icon: <Icon name="eye-slash" />,
        onClick: () => api.setEnabled(false),
      },
    ];
  }, [api, labels, onOpenSettings, settings.kind, settings.width]);
}

interface MinimapContextMenuProps {
  api: MinimapSettingsApi;
  labels?: MinimapLabels;
  // opens the settings modal owned by this editor; falls back to the window
  // event when not given
  onOpenSettings?: () => void;
  children: React.ReactNode;
  style?: React.CSSProperties;
}

/**
 * Wraps a minimap so that right-clicking it offers the style switch, width
 * tweaks and the settings dialog.
 */
export const MinimapContextMenu: React.FC<MinimapContextMenuProps> = ({
  api,
  labels = DEFAULT_LABELS,
  onOpenSettings,
  children,
  style,
}) => {
  const items = useMinimapMenuItems({ api, labels, onOpenSettings });
  return (
    <Dropdown menu={{ items }} trigger={["contextMenu"]}>
      <div style={{ display: "flex", height: "100%", ...style }}>
        {children}
      </div>
    </Dropdown>
  );
};
