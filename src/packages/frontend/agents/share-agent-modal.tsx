/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// "Share with people…" for an existing agent: invite people, who then add the
// agent to their own agents (see agent-participants.ts).

import { useState } from "react";
import { message as antdMessage, Modal } from "antd";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  inviteToAgent,
  inviteToAgentProject,
  projectIncludesAll,
} from "./agent-participants";
import { NewAgentPeople } from "./new-agent-people";

export function ShareAgentModal({
  agent,
  onClose,
}: {
  agent?: NamedAgent;
  onClose: () => void;
}) {
  const projectMap = useTypedRedux("projects", "project_map");
  const [people, setPeople] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const close = () => {
    setPeople([]);
    onClose();
  };
  async function share() {
    if (!agent || people.length === 0) return;
    setBusy(true);
    const project = projectMap?.get(agent.endpoint.project_id);
    const collaborators = people.filter((id) =>
      projectIncludesAll(project, [id]),
    );
    const target = {
      project_id: agent.endpoint.project_id,
      path: agent.path,
      thread_id: agent.thread_id,
      agent_name: agent.name,
    };
    try {
      const reached = [
        ...(await inviteToAgent({ ...target, account_ids: collaborators })),
        ...(await inviteToAgentProject({
          ...target,
          account_ids: people.filter((id) => !collaborators.includes(id)),
        })),
      ];
      if (reached.length < people.length) {
        antdMessage.warning(
          `${people.length - reached.length} of ${people.length} invitations could not be sent.`,
        );
      } else {
        antdMessage.success(
          `Invited ${reached.length} ${reached.length === 1 ? "person" : "people"} to @${agent.name}.`,
        );
      }
      close();
    } catch (err) {
      antdMessage.error(`Unable to share @${agent.name}: ${err}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={agent != null}
      title={agent ? `Share @${agent.name} with people` : "Share agent"}
      okText="Invite"
      okButtonProps={{ disabled: people.length === 0 }}
      confirmLoading={busy}
      onOk={() => void share()}
      onCancel={() => {
        if (!busy) close();
      }}
      destroyOnHidden
    >
      <p>
        People you invite get a notification that opens this agent, where they
        choose “Add to my agents”. Anyone in the agent can start turns and send
        guidance; turns are billed to whoever starts them.
      </p>
      {agent && (
        <NewAgentPeople
          participants={people}
          onChange={setPeople}
          projectId={agent.endpoint.project_id}
          disabled={busy}
        />
      )}
    </Modal>
  );
}
