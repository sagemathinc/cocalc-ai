/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Space, Typography } from "antd";
import { useEffect, useState } from "react";

import {
  COMPUTE_AGENT_GRANTS_PROJECT_DETAIL_FIELD,
  type ComputeAgentGrant,
} from "@cocalc/conat/hub/api/compute";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { subscribeProjectDetailInvalidation } from "@cocalc/frontend/project/use-project-field";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const { Text } = Typography;

function isProjectVmAvailabilityRequest(
  request: Record<string, unknown> | undefined,
): boolean {
  return (
    request?.action === "availability" &&
    ["start-vm", "stop-vm"].includes(`${request?.operation ?? ""}`)
  );
}

function pendingGrantDetails(grant: ComputeAgentGrant): string {
  const request = grant.metadata?.pending_request;
  if (!request) return "VM access";
  return [
    request.operation ?? request.action,
    request.vm_id ? `VM ${`${request.vm_id}`.slice(0, 8)}` : undefined,
    request.provider,
    request.machine_class,
    request.funding_mode,
    Number(request.hourly_usd) > 0
      ? `$${Number(request.hourly_usd).toFixed(3)}/hour maximum`
      : undefined,
    Number(request.total_authorized_usd) > 0
      ? `$${Number(request.total_authorized_usd).toFixed(2)} authorized maximum`
      : undefined,
    Number(request.ttl_minutes) > 0
      ? `${request.ttl_minutes} minute maximum TTL`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function ComputeVmAgentGrantBanner({
  projectId,
}: {
  projectId: string;
}) {
  const [pendingGrants, setPendingGrants] = useState<ComputeAgentGrant[]>([]);
  const [busyGrantId, setBusyGrantId] = useState<string>();
  const [error, setError] = useState<string>();
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  const refresh = async () => {
    const grants = await webapp_client.conat_client.hub.compute.listAgentGrants(
      {
        project_id: projectId,
      },
    );
    setPendingGrants(
      grants.filter((grant) => grant.metadata?.pending_request != null),
    );
  };

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const grants =
          await webapp_client.conat_client.hub.compute.listAgentGrants({
            project_id: projectId,
          });
        if (!disposed) {
          setPendingGrants(
            grants.filter((grant) => grant.metadata?.pending_request != null),
          );
        }
      } catch {
        // This banner is an optional shortcut. The CLI retains the approval
        // URL if the control-plane query is temporarily unavailable.
      }
    };
    const unsubscribe = subscribeProjectDetailInvalidation(
      projectId,
      (fields) => {
        if (fields.includes(COMPUTE_AGENT_GRANTS_PROJECT_DETAIL_FIELD)) {
          void load();
        }
      },
    );
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void load();
    return () => {
      disposed = true;
      unsubscribe();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [projectId]);

  const approve = async (grant: ComputeAgentGrant) => {
    setBusyGrantId(grant.grant_id);
    setError(undefined);
    try {
      const completed = await runFreshAuthAction(async () => {
        await webapp_client.conat_client.hub.compute.approveAgentGrant({
          grant_id: grant.grant_id,
          browser_id: webapp_client.browser_id,
        });
      });
      if (completed) await refresh();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusyGrantId(undefined);
    }
  };

  const deny = async (grant: ComputeAgentGrant) => {
    setBusyGrantId(grant.grant_id);
    setError(undefined);
    try {
      await webapp_client.conat_client.hub.compute.revokeAgentGrant({
        grant_id: grant.grant_id,
      });
      await refresh();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusyGrantId(undefined);
    }
  };

  if (pendingGrants.length === 0 && !error) {
    return <FreshAuthModal {...freshAuthModalProps} />;
  }

  return (
    <div aria-live="assertive">
      {error ? (
        <Alert
          closable
          showIcon
          type="error"
          title="VM approval failed"
          description={error}
          onClose={() => setError(undefined)}
          style={{ marginBottom: 8 }}
        />
      ) : null}
      {pendingGrants.map((grant) => {
        const request = grant.metadata?.pending_request;
        const availabilityRequest = isProjectVmAvailabilityRequest(request);
        return (
          <Alert
            key={grant.grant_id}
            banner
            showIcon
            type="warning"
            title={
              availabilityRequest
                ? "Codex requests VM start/stop access for this turn"
                : "Codex requests temporary VM authority"
            }
            description={
              <Space orientation="vertical" size={6}>
                <Text>
                  {availabilityRequest
                    ? "Allow this Codex turn to start and stop existing VMs in this project without asking again. Starting a VM incurs its configured price."
                    : "Approve this exact VM request so the waiting Codex command can continue automatically."}
                </Text>
                <Text type="secondary">
                  {pendingGrantDetails(grant)}. This does not place an account
                  session in the project.
                </Text>
                <Space wrap>
                  <Button
                    type="primary"
                    size="small"
                    loading={busyGrantId === grant.grant_id}
                    onClick={() => void approve(grant)}
                  >
                    {availabilityRequest
                      ? "Allow start/stop for this turn"
                      : "Approve exact request"}
                  </Button>
                  <Button
                    size="small"
                    disabled={busyGrantId === grant.grant_id}
                    onClick={() => void deny(grant)}
                  >
                    Deny
                  </Button>
                </Space>
              </Space>
            }
          />
        );
      })}
      <FreshAuthModal {...freshAuthModalProps} />
    </div>
  );
}
