/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Space, Typography } from "antd";
import type { ComputeAgentGrant } from "@cocalc/conat/hub/api/compute";
import { useEffect, useRef, useState } from "@cocalc/frontend/app-framework";
import { projectFileBasePath } from "@cocalc/frontend/lib/cocalc-urls";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const { Text } = Typography;
const AGENT_GRANT_POLL_MS = 2_000;

function pendingGrant(
  grants: ComputeAgentGrant[],
): ComputeAgentGrant | undefined {
  return grants.find((grant) => grant.metadata?.pending_request != null);
}

export function CodexVmApprovalPrompt({
  projectId,
  active,
}: {
  projectId?: string;
  active: boolean;
}) {
  const [grant, setGrant] = useState<ComputeAgentGrant>();
  const observedGrantId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!active || !projectId) {
      setGrant(undefined);
      observedGrantId.current = undefined;
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const grants =
          await webapp_client.conat_client.hub.compute.listAgentGrants({
            project_id: projectId,
          });
        if (!disposed) {
          const pending = pendingGrant(grants);
          if (pending) {
            observedGrantId.current = pending.grant_id;
            setGrant(pending);
          } else if (observedGrantId.current) {
            setGrant(
              grants.find(
                (candidate) =>
                  candidate.grant_id === observedGrantId.current &&
                  candidate.metadata?.approved_at != null,
              ),
            );
          }
        }
      } catch {
        // The terminal command still reports the request if this optional UI
        // shortcut cannot reach the control plane.
      } finally {
        if (!disposed)
          timer = setTimeout(() => void poll(), AGENT_GRANT_POLL_MS);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, projectId]);

  if (!grant || !projectId) return null;
  const approved = grant.metadata?.pending_request == null;
  const request =
    grant.metadata?.pending_request ?? grant.metadata?.approved_request ?? {};
  const operation = `${request.operation ?? request.action ?? "VM action"}`;
  const approvalUrl = `${projectFileBasePath(projectId)}/vms?agent_grant=${encodeURIComponent(grant.grant_id)}`;

  return (
    <Alert
      showIcon
      type={approved ? "success" : "warning"}
      title={approved ? "VM access approved" : "Codex needs VM approval"}
      description={
        <Space direction="vertical" size={8}>
          <Text>
            {approved
              ? `Codex is continuing the ${operation} operation. VM start and stop operations can take about a minute.`
              : `Review the ${operation} request. The running CLI command will continue automatically after approval.`}
          </Text>
          {!approved && (
            <Button type="primary" href={approvalUrl} target="_blank">
              Review and approve VM access
            </Button>
          )}
        </Space>
      }
      style={{ marginBottom: 8 }}
    />
  );
}
