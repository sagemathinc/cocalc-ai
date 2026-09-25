/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import { LinkOutlined } from "@ant-design/icons";
import { Alert, Button, Modal, Space, Spin, Switch } from "antd";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type { CocalcConnectorConfig } from "@cocalc/conat/hub/api/agent";
import type { ApiKeyScope } from "@cocalc/util/db-schema/api-keys";
import {
  ApiKeyScopeEditor,
  EMPTY_API_KEY_SCOPE,
} from "@cocalc/frontend/components/api-key-scope-editor";
import { personalAgentApi } from "./api";

export function CocalcConnector({ agent }: { agent: NamedAgent }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [config, setConfig] = useState<CocalcConnectorConfig | null>(null);
  const [scope, setScope] = useState<ApiKeyScope>(EMPTY_API_KEY_SCOPE);
  const [enabled, setEnabled] = useState(false);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoaded(false);
    setError("");
    void personalAgentApi()
      .getCocalcConnectorConfig({
        agent_id: agent.endpoint.agent_id,
        source_project_id: agent.endpoint.project_id,
      })
      .then((saved) => {
        if (cancelled) return;
        setConfig(saved);
        setScope(saved?.scope ?? EMPTY_API_KEY_SCOPE);
        setEnabled(saved?.enabled ?? false);
        setLoaded(true);
      })
      .catch((err) => {
        if (!cancelled) setError(`${err}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, agent.endpoint.agent_id, agent.endpoint.project_id]);

  async function save() {
    setSaving(true);
    setError("");
    try {
      const completed = await runFreshAuthAction(async () => {
        const saved = await personalAgentApi().saveCocalcConnectorConfig({
          agent_id: agent.endpoint.agent_id,
          source_project_id: agent.endpoint.project_id,
          expected_revision: config?.revision,
          scope,
          enabled,
        });
        setConfig(saved);
      });
      if (completed) setOpen(false);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button
        aria-label="CoCalc access"
        title="CoCalc access"
        type="text"
        size="small"
        icon={<LinkOutlined />}
        onClick={() => setOpen(true)}
      />
      <Modal
        open={open}
        title={`CoCalc access for @${agent.name}`}
        onCancel={() => setOpen(false)}
        width={700}
        footer={
          <Space>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              type="primary"
              loading={saving}
              disabled={loading || !loaded}
              onClick={() => void save()}
            >
              Save access
            </Button>
          </Space>
        }
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          {error && (
            <Alert
              type="error"
              title="Unable to load or save access"
              description={error}
            />
          )}
          {loading ? (
            <Spin aria-label="Loading CoCalc access" />
          ) : (
            <>
              <div>
                <Switch
                  aria-label="Enable CoCalc access"
                  checked={enabled}
                  onChange={setEnabled}
                  style={{ marginRight: 8 }}
                />
                Enable CoCalc access
              </div>
              <ApiKeyScopeEditor value={scope} onChange={setScope} />
              <Alert
                type="warning"
                title="Temporary credential in a shared project"
                description="During a turn, processes and collaborators in this agent's project may use its credential. Revocation blocks new credential-backed operations; it does not undo copied data or stop processes already started."
              />
            </>
          )}
        </Space>
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}
