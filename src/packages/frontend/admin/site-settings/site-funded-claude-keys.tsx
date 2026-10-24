/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

// The site's Anthropic keys for site-funded Claude: in order, each with its
// own monthly spend limit and reset point. A turn uses the first key with
// room left this month, then the next.

import {
  Alert,
  Button,
  Card,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Space,
  Switch,
  Table,
} from "antd";
import { useEffect, useRef, useState } from "react";
import type {
  SiteFundedProviderKeyAction,
  SiteFundedProviderKeyInfo,
} from "@cocalc/util/ai/site-funded-claude";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { Icon } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";

function dollars(microusd: number): string {
  return `$${(microusd / 1_000_000).toFixed(2)}`;
}

export function resetLabel(day: number, hour: number): string {
  return `Day ${day}, ${`${hour}`.padStart(2, "0")}:00 UTC`;
}

type KeyDraft = {
  label: string;
  apiKey: string;
  monthlyLimitUsd: number | null;
  resetDay: number | null;
  resetHour: number | null;
};

const NEW_KEY: KeyDraft = {
  label: "",
  apiKey: "",
  monthlyLimitUsd: 100,
  resetDay: 1,
  resetHour: 0,
};

export function KeyForm({
  draft,
  setDraft,
  isNew,
}: {
  draft: KeyDraft;
  setDraft: (draft: KeyDraft) => void;
  isNew: boolean;
}) {
  const row = (label: string, input: React.ReactNode) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ marginBottom: 4 }}>{label}</div>
      {input}
    </div>
  );
  return (
    <div>
      {row(
        "Label",
        <Input
          aria-label="Label"
          value={draft.label}
          placeholder="Anthropic workspace for site-funded Claude"
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
        />,
      )}
      {isNew
        ? row(
            "API key",
            <Input.Password
              aria-label="API key"
              value={draft.apiKey}
              placeholder="sk-ant-..."
              autoComplete="off"
              onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            />,
          )
        : null}
      {row(
        "Monthly limit (USD)",
        <InputNumber
          aria-label="Monthly limit (USD)"
          min={0}
          step={10}
          value={draft.monthlyLimitUsd}
          onChange={(value) => setDraft({ ...draft, monthlyLimitUsd: value })}
        />,
      )}
      <Space size={16}>
        {row(
          "Resets on day (1-28)",
          <InputNumber
            aria-label="Resets on day"
            min={1}
            max={28}
            value={draft.resetDay}
            onChange={(value) => setDraft({ ...draft, resetDay: value })}
          />,
        )}
        {row(
          "at hour (0-23, UTC)",
          <InputNumber
            aria-label="at hour"
            min={0}
            max={23}
            value={draft.resetHour}
            onChange={(value) => setDraft({ ...draft, resetHour: value })}
          />,
        )}
      </Space>
    </div>
  );
}

export default function SiteFundedClaudeKeysCard() {
  const [keys, setKeys] = useState<SiteFundedProviderKeyInfo[]>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  // The key being edited, or "new" while adding one.
  const [editing, setEditing] = useState<SiteFundedProviderKeyInfo | "new">();
  const [draft, setDraft] = useState<KeyDraft>(NEW_KEY);
  const lock = useRef(false);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setKeys(
        await webapp_client.conat_client.hub.system.getSiteFundedClaudeKeys({}),
      );
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  // Every change spends the site's money: it needs a fresh sign-in.
  const act = async (action: SiteFundedProviderKeyAction): Promise<boolean> => {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      return await runFreshAuthAction(async () => {
        setKeys(
          await webapp_client.conat_client.hub.system.manageSiteFundedClaudeKeys(
            { action, browser_id: webapp_client.browser_id },
          ),
        );
      });
    } catch (err) {
      setError(`${err}`);
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  const move = (index: number, delta: number) => {
    if (!keys) return;
    const order = keys.map(({ keyId }) => keyId);
    const [moved] = order.splice(index, 1);
    order.splice(index + delta, 0, moved);
    void act({ op: "reorder", keyIds: order });
  };

  const openEditor = (key: SiteFundedProviderKeyInfo | "new") => {
    setDraft(
      key === "new"
        ? NEW_KEY
        : {
            label: key.label,
            apiKey: "",
            monthlyLimitUsd: key.monthlyLimitMicrousd / 1_000_000,
            resetDay: key.resetDay,
            resetHour: key.resetHour,
          },
    );
    setEditing(key);
  };

  const save = async () => {
    if (editing == null) return;
    const settings = {
      label: draft.label.trim(),
      monthlyLimitUsd: draft.monthlyLimitUsd ?? 0,
      resetDay: draft.resetDay ?? 1,
      resetHour: draft.resetHour ?? 0,
    };
    const saved = await act(
      editing === "new"
        ? { op: "add", apiKey: draft.apiKey.trim(), ...settings }
        : { op: "update", keyId: editing.keyId, ...settings },
    );
    if (saved) setEditing(undefined);
  };

  return (
    <Card
      size="small"
      title="Anthropic keys for site-funded Claude"
      extra={
        <Space>
          <Button
            size="small"
            loading={loading}
            icon={<Icon name="refresh" />}
            onClick={() => void load()}
          >
            Refresh
          </Button>
          <Button
            size="small"
            type="primary"
            disabled={busy}
            onClick={() => openEditor("new")}
          >
            Add key
          </Button>
        </Space>
      }
      style={{ marginBottom: 20, width: "100%" }}
    >
      <div style={{ marginBottom: 12, color: UI_COLORS.secondary }}>
        A Claude turn is paid for by the first enabled key, in this order, that
        has room left in its month. Each key has its own monthly limit and reset
        point. When every key is used up, included Claude is unavailable until
        one resets.
      </div>
      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          title="Could not change the keys"
          description={error}
        />
      ) : null}
      <Table
        size="small"
        pagination={false}
        rowKey="keyId"
        loading={loading}
        dataSource={keys ?? []}
        locale={{ emptyText: "No keys yet: add one to fund Claude turns" }}
        columns={[
          {
            title: "Order",
            key: "order",
            render: (_: unknown, _row, index: number) => (
              <Space size={4}>
                <span>{index + 1}</span>
                <Button
                  size="small"
                  aria-label="Move up"
                  icon={<Icon name="arrow-up" />}
                  disabled={busy || index === 0}
                  onClick={() => move(index, -1)}
                />
                <Button
                  size="small"
                  aria-label="Move down"
                  icon={<Icon name="arrow-down" />}
                  disabled={busy || index === (keys?.length ?? 0) - 1}
                  onClick={() => move(index, 1)}
                />
              </Space>
            ),
          },
          { title: "Label", dataIndex: "label" },
          {
            title: "Key",
            dataIndex: "last4",
            render: (last4: string) => <code>…{last4}</code>,
          },
          {
            title: "This month",
            key: "spend",
            render: (_: unknown, key: SiteFundedProviderKeyInfo) => (
              <div style={{ minWidth: 160 }}>
                <Progress
                  size="small"
                  percent={Math.min(
                    100,
                    key.monthlyLimitMicrousd
                      ? Math.round(
                          (100 * key.exposureMicrousd) /
                            key.monthlyLimitMicrousd,
                        )
                      : 100,
                  )}
                />
                {dollars(key.exposureMicrousd)} of{" "}
                {dollars(key.monthlyLimitMicrousd)}
              </div>
            ),
          },
          {
            title: "Resets",
            key: "reset",
            render: (_: unknown, key: SiteFundedProviderKeyInfo) => (
              <span title={`Next: ${new Date(key.periodEnd).toLocaleString()}`}>
                {resetLabel(key.resetDay, key.resetHour)}
              </span>
            ),
          },
          {
            title: "Enabled",
            dataIndex: "enabled",
            render: (enabled: boolean, key: SiteFundedProviderKeyInfo) => (
              <Switch
                size="small"
                aria-label={`Enable ${key.label}`}
                checked={enabled}
                disabled={busy}
                onChange={(checked) =>
                  void act({ op: "update", keyId: key.keyId, enabled: checked })
                }
              />
            ),
          },
          {
            title: "",
            key: "actions",
            render: (_: unknown, key: SiteFundedProviderKeyInfo) => (
              <Space size={4}>
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() => openEditor(key)}
                >
                  Edit
                </Button>
                <Popconfirm
                  title={`Remove ${key.label}?`}
                  description="Turns can no longer be funded by it. Its past spend stays recorded."
                  okText="Remove"
                  onConfirm={() => void act({ op: "remove", keyId: key.keyId })}
                >
                  <Button size="small" danger disabled={busy}>
                    Remove
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        open={editing != null}
        title={editing === "new" ? "Add an Anthropic key" : "Edit key"}
        okText={editing === "new" ? "Add key" : "Save"}
        confirmLoading={busy}
        okButtonProps={{
          disabled:
            !draft.label.trim() || (editing === "new" && !draft.apiKey.trim()),
        }}
        onOk={() => void save()}
        onCancel={() => setEditing(undefined)}
        destroyOnHidden
      >
        <KeyForm draft={draft} setDraft={setDraft} isNew={editing === "new"} />
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </Card>
  );
}
