/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Button,
  Checkbox,
  Divider,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "@cocalc/frontend/components";
import {
  DragHandle,
  SortableItem,
  SortableList,
} from "@cocalc/frontend/components/sortable-list";
import { file_associations } from "@cocalc/frontend/file-associations";
import { file_options } from "@cocalc/frontend/editor-tmp";
import { capitalize, keys } from "@cocalc/util/misc";
import { QUICK_CREATE_CATALOG, QUICK_CREATE_MAP } from "./launcher-catalog";
import {
  LauncherProjectDefaults,
  LauncherUserPrefs,
} from "./launcher-preferences";

function move<T>(list: T[], index: number, delta: number): T[] {
  const next = list.slice();
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

function reorder<T>(list: T[], oldIndex: number, newIndex: number): T[] {
  return move(list, oldIndex, newIndex - oldIndex);
}

function launcherLabel(value?: string): string {
  return capitalize(value ?? "");
}

interface Props {
  open: boolean;
  onClose: () => void;
  initialQuickCreate: string[];
  userBaseQuickCreate?: string[];
  projectBaseQuickCreate?: string[];
  onSaveUser?: (prefs: LauncherUserPrefs | null) => void;
  onSaveProject?: (prefs: LauncherProjectDefaults) => void;
  canEditProjectDefaults?: boolean;
  saveMode?: "user" | "project";
  contributions?: LauncherContributionLayer[];
}

export interface LauncherContributionLayer {
  key: string;
  title: string;
  quickCreateAdd?: string[];
  quickCreateRemove?: string[];
}

export function LauncherCustomizeModal({
  open,
  onClose,
  initialQuickCreate,
  userBaseQuickCreate,
  projectBaseQuickCreate,
  onSaveUser,
  onSaveProject,
  canEditProjectDefaults = false,
  saveMode = "user",
  contributions = [],
}: Props) {
  const [quickCreate, setQuickCreate] = useState<string[]>([]);
  const [showMergeDetails, setShowMergeDetails] = useState<boolean>(false);
  const userBaseQuick = userBaseQuickCreate ?? initialQuickCreate;
  const projectBaseQuick = projectBaseQuickCreate ?? userBaseQuick;

  useEffect(() => {
    if (!open) return;
    setQuickCreate(initialQuickCreate);
    setShowMergeDetails(false);
  }, [open, initialQuickCreate]);

  function toggleQuickCreate(id: string, checked: boolean) {
    if (checked) {
      if (!quickCreate.includes(id)) {
        setQuickCreate([...quickCreate, id]);
      }
    } else {
      setQuickCreate(quickCreate.filter((item) => item !== id));
    }
  }

  function saveUser() {
    if (!onSaveUser) {
      onClose();
      return;
    }
    const addQuick = quickCreate.filter((id) => !userBaseQuick.includes(id));
    const removeQuick = userBaseQuick.filter((id) => !quickCreate.includes(id));
    onSaveUser({
      quickCreate: addQuick,
      hiddenQuickCreate: removeQuick,
      quickCreateOrder: quickCreate,
    });
    onClose();
  }

  function resetUser() {
    if (!onSaveUser) {
      onClose();
      return;
    }
    onSaveUser(null);
    onClose();
  }

  function saveProjectDefaults() {
    const addQuick = quickCreate.filter((id) => !projectBaseQuick.includes(id));
    const removeQuick = projectBaseQuick.filter(
      (id) => !quickCreate.includes(id),
    );
    onSaveProject?.({
      quickCreate: addQuick,
      hiddenQuickCreate: removeQuick,
      quickCreateOrder: quickCreate,
    });
    onClose();
  }

  function discardChanges() {
    onClose();
  }

  function resetProjectDefaults() {
    onSaveProject?.({});
    onClose();
  }

  const isProjectMode = saveMode === "project";

  const hiddenQuick = QUICK_CREATE_CATALOG.filter(
    (spec) => !quickCreate.includes(spec.id),
  );

  function renderQuickRow(
    id: string,
    checked: boolean,
    draggable: boolean,
    clickable: boolean,
  ) {
    const spec =
      QUICK_CREATE_MAP[id] ??
      (() => {
        const data = file_options(`x.${id}`);
        return {
          icon: data.icon ?? "file",
          label: launcherLabel(data.name ?? id),
        };
      })();
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 0",
          cursor: clickable ? "pointer" : undefined,
        }}
        onClick={
          clickable
            ? () => {
                toggleQuickCreate(id, true);
              }
            : undefined
        }
      >
        <Space>
          {draggable ? (
            <DragHandle id={id} />
          ) : (
            <span style={{ width: "18px", display: "inline-block" }} />
          )}
          <Icon name={spec.icon} />
          <span>{spec.label}</span>
        </Space>
        <Checkbox
          checked={checked}
          onChange={(e) => toggleQuickCreate(id, e.target.checked)}
        />
      </div>
    );
  }

  function quickLabel(id: string): string {
    const spec = QUICK_CREATE_MAP[id];
    if (spec) return spec.label;
    const data = file_options(`x.${id}`);
    return launcherLabel(data.name ?? id);
  }

  function renderTags(
    ids: string[] | undefined,
    color: string,
    label: (id: string) => string,
    prefix: string,
  ) {
    if (!ids?.length) {
      return <Typography.Text type="secondary">none</Typography.Text>;
    }
    return (
      <Space size={[6, 6]} wrap>
        {ids.map((id) => (
          <Tag
            key={`${prefix}-${id}`}
            color={color}
            style={{ marginInlineEnd: 0 }}
          >
            {label(id)} <span style={{ opacity: 0.65 }}>({id})</span>
          </Tag>
        ))}
      </Space>
    );
  }

  return (
    <Modal
      title="Customize Launcher"
      open={open}
      onCancel={isProjectMode ? saveProjectDefaults : saveUser}
      onOk={isProjectMode ? saveProjectDefaults : saveUser}
      okText="Save"
      cancelText="Save"
      footer={
        <Space style={{ width: "100%", justifyContent: "space-between" }}>
          <Space>
            {isProjectMode ? (
              <Button onClick={resetProjectDefaults}>Reset to defaults</Button>
            ) : (
              <Button onClick={resetUser}>Reset to defaults</Button>
            )}
            {!isProjectMode && canEditProjectDefaults && onSaveProject && (
              <Button onClick={saveProjectDefaults} type="default">
                Save as project defaults
              </Button>
            )}
          </Space>
          <Space>
            <Button danger onClick={discardChanges}>
              Discard changes
            </Button>
            <Button
              type="primary"
              onClick={isProjectMode ? saveProjectDefaults : saveUser}
            >
              Save
            </Button>
          </Space>
        </Space>
      }
      width={860}
    >
      <div style={{ marginBottom: "8px" }}>
        <Button
          size="small"
          type="default"
          onClick={() => setShowMergeDetails(!showMergeDetails)}
        >
          <Icon name={showMergeDetails ? "caret-down" : "caret-right"} /> How
          this merges
        </Button>
      </div>
      {showMergeDetails && (
        <div style={{ marginBottom: "14px" }}>
          <Typography.Paragraph style={{ marginBottom: "6px" }}>
            Quick Create entries are merged additively in this order: built-in
            defaults, site defaults, project defaults, account defaults, then
            project-user overrides.
          </Typography.Paragraph>
          <Typography.Paragraph style={{ marginBottom: "10px" }}>
            Each layer can add items and explicitly remove inherited items.
          </Typography.Paragraph>
          <Typography.Text strong>Current contributions</Typography.Text>
          <div
            style={{
              marginTop: "6px",
              display: "grid",
              gridTemplateColumns: "1fr",
              gap: "8px",
              maxHeight: "220px",
              overflowY: "auto",
              border: "1px solid #f0f0f0",
              borderRadius: "8px",
              padding: "10px",
            }}
          >
            {contributions.map((layer) => (
              <div
                key={layer.key}
                style={{
                  borderBottom: "1px dashed #f0f0f0",
                  paddingBottom: "8px",
                }}
              >
                <Typography.Text strong>{layer.title}</Typography.Text>
                <div style={{ marginTop: "4px" }}>
                  <Typography.Text type="secondary">Quick + </Typography.Text>
                  {renderTags(
                    layer.quickCreateAdd,
                    "blue",
                    quickLabel,
                    `${layer.key}-qadd`,
                  )}
                </div>
                <div style={{ marginTop: "4px" }}>
                  <Typography.Text type="secondary">Quick - </Typography.Text>
                  {renderTags(
                    layer.quickCreateRemove,
                    "volcano",
                    quickLabel,
                    `${layer.key}-qremove`,
                  )}
                </div>
              </div>
            ))}
            <div>
              <Typography.Text strong>
                Effective quick create state
              </Typography.Text>
              <div style={{ marginTop: "4px" }}>
                <Typography.Text type="secondary">
                  Quick Create:{" "}
                </Typography.Text>
                {renderTags(
                  quickCreate,
                  "processing",
                  quickLabel,
                  "effective-quick",
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "24px",
        }}
      >
        <div>
          <Typography.Title level={5} style={{ marginBottom: "6px" }}>
            Quick Create
          </Typography.Title>
          <SortableList
            items={quickCreate}
            onDragStop={(oldIndex, newIndex) =>
              setQuickCreate(reorder(quickCreate, oldIndex, newIndex))
            }
            Item={({ id }: { id: string }) =>
              renderQuickRow(id, true, true, false)
            }
          >
            {quickCreate.map((id) => (
              <SortableItem key={id} id={id}>
                {renderQuickRow(id, true, true, false)}
              </SortableItem>
            ))}
          </SortableList>
        </div>
        <div>
          <Typography.Title level={5} style={{ marginBottom: "6px" }}>
            Available
          </Typography.Title>
          <Typography.Text type="secondary">
            Search more available launchers
          </Typography.Text>
          <Select<string>
            showSearch
            allowClear
            placeholder="Search more launchers..."
            style={{ width: "100%", marginTop: "6px" }}
            value={undefined}
            options={(() => {
              const list = keys(file_associations).sort();
              const seen = new Set<string>();
              const options: { value: string; label: ReactNode }[] = [];
              for (let ext of list) {
                if (ext === "/" || ext === "sage") continue;
                const data = file_associations[ext];
                if (data?.exclude_from_menu) continue;
                if (data?.name && seen.has(data.name)) continue;
                if (data?.name) seen.add(data.name);
                const value = data?.ext ?? ext;
                if (!value || value === "sage") continue;
                if (quickCreate.includes(value)) continue;
                const info = file_options(`x.${value}`);
                options.push({
                  value,
                  label: (
                    <span>
                      <Icon name={info.icon ?? "file"} />{" "}
                      {launcherLabel(info.name ?? value)}{" "}
                      <span style={{ opacity: 0.6 }}>({value})</span>
                    </span>
                  ),
                });
              }
              return options;
            })()}
            onSelect={(value: string) => {
              if (!quickCreate.includes(value)) {
                setQuickCreate([value, ...quickCreate]);
              }
            }}
          />
          <Divider style={{ margin: "10px 0" }} />
          {hiddenQuick.map((spec) => (
            <div key={spec.id}>
              {renderQuickRow(spec.id, false, false, true)}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
