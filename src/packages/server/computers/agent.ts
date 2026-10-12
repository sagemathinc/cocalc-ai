/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// `cocalc computer ...` from an agent, with its runtime identity. Account,
// project, run and thread come from the authenticated run, never from the
// request. Every operation needs an eligible project (its only collaborator
// is the account), attested by the project's bay, because every process in a
// shared project could act as this agent during its turn.
// Plan: src/.agents/computers-plan-2026-10-11.md ("Trust boundaries").

import type { AgentComputerRequest } from "@cocalc/conat/agents/computers";
import { validateAgentComputerRequest } from "@cocalc/conat/agents/computers";
import type {
  ProjectAttestation,
  SignedEnvelope,
} from "@cocalc/util/computers/protocol";
import { resolveProjectOwningBay } from "@cocalc/server/bay-directory";
import type { AgentRun } from "@cocalc/server/agents/store";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { accountHomeBay, computersAtBay } from "./routing";
import { relayToComputer } from "./relay";

export async function agentComputerRequest(
  run: AgentRun,
  request: AgentComputerRequest,
): Promise<unknown> {
  validateAgentComputerRequest(request);
  const account_id = run.account_id;
  const project_id = run.project_id;
  const agent_id = run.agent_id;
  const home_bay_id = await accountHomeBay(account_id);
  const attestation = await attest(run, home_bay_id);
  if (!attestation.payload.eligible) {
    const reason = await explainIneligibility(run).catch(() => null);
    throw new Error(
      reason ??
        "this project can't use computers right now (they need a project whose only collaborator is you)",
    );
  }
  const home = computersAtBay(home_bay_id);
  switch (request.op) {
    case "list":
      return {
        computers: await home.listForAgent({
          account_id,
          agent_id,
          project_id,
        }),
      };
    case "show":
      return {
        computer: await home.getForAgent({
          account_id,
          agent_id,
          project_id,
          computer: request.computer,
        }),
      };
    case "request":
      return await home.createRequest({
        account_id,
        requested_by: {
          agent_id,
          run_id: run.run_id,
          project_id,
          thread_id: run.thread_id ?? null,
        },
        name: request.name,
        requested_policy: request.policy,
        why: request.why ?? "",
      });
    case "notes":
      // One home-bay transaction rechecks membership while it writes.
      return await home.setNotes({
        account_id,
        computer: request.computer,
        author: { kind: "agent", agent_id, project_id },
        notes: request.notes,
        expected_revision: request.expected_revision,
      });
    case "ticket":
      return await home.issueTicket({
        account_id,
        agent_id,
        run_id: run.run_id,
        source_project_id: project_id,
        run_expires_at: new Date(run.expires_at).valueOf(),
        thread_id: run.thread_id ?? null,
        computer: request.computer,
        operation: request.operation,
        request: request.request,
        operation_id: request.operation_id,
        pop_key: request.pop_key,
        attestation,
      });
    case "send":
      // Stage 1: the computer's sessions live at the account's home bay.
      if (home_bay_id !== getConfiguredBayId()) {
        throw new Error(
          "sending to a computer from another bay isn't supported yet",
        );
      }
      return await relayToComputer({
        account_id,
        agent_id,
        run_id: run.run_id,
        source_project_id: project_id,
        ticket: request.ticket,
        proof: request.proof,
        request: request.request,
      });
  }
}

/** Why the project's owning bay says it can't use computers. */
async function explainIneligibility(run: AgentRun): Promise<string | null> {
  const { owning_bay_id } = await resolveProjectOwningBay({
    account_id: run.account_id,
    project_id: run.project_id,
  });
  return await computersAtBay(owning_bay_id).explainProjectIneligibility({
    project_id: run.project_id,
    account_id: run.account_id,
  });
}

/** A fresh attestation from the project's owning bay. */
async function attest(
  run: AgentRun,
  home_bay_id: string,
): Promise<SignedEnvelope<ProjectAttestation>> {
  const { owning_bay_id } = await resolveProjectOwningBay({
    account_id: run.account_id,
    project_id: run.project_id,
  });
  return await computersAtBay(owning_bay_id).attestProject({
    project_id: run.project_id,
    account_id: run.account_id,
    home_bay_id,
  });
}
