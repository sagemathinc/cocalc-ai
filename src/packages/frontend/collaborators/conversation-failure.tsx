/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { Alert, Button } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import {
  evaluateHostOperational,
  getProjectLifecycleView,
} from "@cocalc/frontend/projects/host-operational";

/** Read-only context for a failed attempt; never starts or restores compute. */
export function ConversationFailure({
  projectId,
  error,
  dispatched,
  onManageProject,
}: {
  projectId: string;
  error: string;
  dispatched: boolean;
  onManageProject?: () => void;
}) {
  const project = useTypedRedux("projects", "project_map")?.get(projectId);
  const hostId = project?.get("host_id");
  const hostInfo = useHostInfo(hostId);
  const lifecycle = getProjectLifecycleView({
    projectState: project?.getIn(["state", "state"]),
    lastBackup: project?.get("last_backup"),
    hostId,
    hostInfo,
  });
  const host = evaluateHostOperational(hostInfo);
  const unavailable = host.state === "unavailable";
  const explanation = lifecycle.isArchived
    ? "This project is archived. Restore it from project settings before starting a conversation."
    : lifecycle.isNew
      ? "This project has not been started yet. Open it from project settings before starting a conversation."
      : unavailable
        ? `The project host is unavailable. ${host.reason ?? ""} Check project settings, or wait for the host to come online before retrying.`
        : "CoCalc could not complete the conversation request. Check the project's availability in project settings, then retry.";
  return (
    <Alert
      role="alert"
      type="error"
      title={
        dispatched
          ? "Conversation not confirmed"
          : "Could not start conversation"
      }
      description={
        <>
          <p>{explanation}</p>
          <p>
            {dispatched
              ? "The request may have reached the project. Retry uses the same room and thread identity; it does not create a duplicate discussion."
              : "The conversation request was not sent to the project. You can retry or choose another shared project."}
          </p>
          {onManageProject && (
            <Button onClick={onManageProject}>Project settings</Button>
          )}
          <details style={{ marginTop: 8 }}>
            <summary>Technical details</summary>
            <p style={{ overflowWrap: "anywhere" }}>{error}</p>
          </details>
        </>
      }
    />
  );
}
