/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { LinkOutlined, QuestionCircleOutlined } from "@ant-design/icons";
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
import { openProjectDocs } from "@cocalc/frontend/docs/navigation";

export function CocalcConnector({
  agent,
  composer = false,
  renderTrigger,
}: {
  agent: NamedAgent;
  composer?: boolean;
  renderTrigger?: (state: {
    config: CocalcConnectorConfig | null;
    onOpen: () => void;
  }) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [config, setConfig] = useState<CocalcConnectorConfig | null>(null);
  const [scope, setScope] = useState<ApiKeyScope>(EMPTY_API_KEY_SCOPE);
  const [enabled, setEnabled] = useState(false);
  const [loadRequest, setLoadRequest] = useState(0);
  const preload = !!renderTrigger;
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  useEffect(() => {
    if (!preload && loadRequest === 0) return;
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
        const savedScope = saved?.scope ?? EMPTY_API_KEY_SCOPE;
        setScope({
          ...savedScope,
          projects: savedScope.projects.filter(
            (grant) => grant.project_id !== agent.endpoint.project_id,
          ),
        });
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
  }, [
    preload,
    loadRequest,
    agent.endpoint.agent_id,
    agent.endpoint.project_id,
  ]);

  function onOpen() {
    setLoadRequest((request) => request + 1);
    setOpen(true);
  }

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
      {renderTrigger ? (
        renderTrigger({ config, onOpen })
      ) : (
        <Button
          aria-label={composer ? "CoCalc connector" : "CoCalc access"}
          title="CoCalc access"
          type={composer ? "default" : "text"}
          size="small"
          icon={<LinkOutlined />}
          onClick={onOpen}
        >
          {composer ? "CoCalc" : null}
        </Button>
      )}
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
                <Button
                  type="text"
                  aria-label="Learn about CoCalc access"
                  title="Learn about CoCalc access"
                  icon={<QuestionCircleOutlined />}
                  onClick={() => {
                    setOpen(false);
                    openProjectDocs({
                      projectId: agent.endpoint.project_id,
                      slug: "ai/cocalc-access",
                    });
                  }}
                />
              </div>
              <div>
                These settings apply to @{agent.name} across conversations. The
                agent already has full access to its own project.
              </div>
              <ApiKeyScopeEditor
                value={scope}
                onChange={setScope}
                excludeProjectIds={[agent.endpoint.project_id]}
              />
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
