/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  Button,
  Checkbox,
  Divider,
  Modal,
  Select,
  Space,
  Typography,
} from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
import type { LauncherPrefs } from "./launcher-preferences";

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
  inheritedQuickCreate?: string[];
  onSave?: (prefs: LauncherPrefs | null) => void;
  resetLabel?: string;
  title?: string;
}

export function LauncherCustomizeModal({
  open,
  onClose,
  initialQuickCreate,
  onSave,
  resetLabel = "Reset to inherited default",
  title = "Customize Launcher",
}: Props) {
  const [quickCreate, setQuickCreate] = useState<string[]>([]);
  const wasOpenRef = useRef<boolean>(false);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setQuickCreate(initialQuickCreate);
    }
    wasOpenRef.current = open;
  }, [initialQuickCreate, open]);

  function toggleQuickCreate(id: string, checked: boolean) {
    if (checked) {
      if (!quickCreate.includes(id)) {
        setQuickCreate([...quickCreate, id]);
      }
    } else {
      setQuickCreate(quickCreate.filter((item) => item !== id));
    }
  }

  function save() {
    const prefs = { quickCreate };
    onSave?.(prefs);
    onClose();
  }

  function reset() {
    onSave?.(null);
    onClose();
  }

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
          alignItems: "center",
          cursor: clickable ? "pointer" : undefined,
          display: "flex",
          justifyContent: "space-between",
          padding: "4px 0",
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
            <span style={{ display: "inline-block", width: 18 }} />
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

  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      onOk={save}
      footer={
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <Button onClick={reset}>{resetLabel}</Button>
          <Space>
            <Button onClick={onClose}>Cancel</Button>
            <Button type="primary" onClick={save}>
              Save
            </Button>
          </Space>
        </Space>
      }
      width={860}
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        Choose the exact Quick Create buttons to show, then drag them into the
        order you want.
      </Typography.Paragraph>
      <div
        style={{
          display: "grid",
          gap: 24,
          gridTemplateColumns: "1fr 1fr",
        }}
      >
        <div>
          <Typography.Title level={5} style={{ marginBottom: 6 }}>
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
          <Typography.Title level={5} style={{ marginBottom: 6 }}>
            Available
          </Typography.Title>
          <Typography.Text type="secondary">
            Search additional launchers by file type.
          </Typography.Text>
          <Select<string>
            showSearch
            allowClear
            placeholder="Search more launchers..."
            style={{ marginTop: 6, width: "100%" }}
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
