/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

/*
Merge approvals, seed bay only.

- request: an agent, acting for the project its session token is bound to,
  asks for approval of one exact pull-request head. The hub reads the PR from
  GitHub and refuses unless it is open and its head is that commit.
- decide: an approver (site setting merge_approvers) approves or rejects,
  from a freshly authenticated browser session, never while impersonated,
  and with a recent second factor to approve where the repo requires one.
  Approvers' accounts must be homed on the seed, where their sessions are.

The hub API principal policies (conat/hub/api/merge-approvals.ts) already
limit request to agent sessions and decide to account sessions; the checks
here repeat that, so no other caller of these functions can skip it.
*/

import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import { getImpersonationSessionBySessionHash } from "@cocalc/server/auth/impersonation";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { isValidUUID } from "@cocalc/util/misc";
import {
  MAX_MERGE_APPROVAL_COMMENT_BYTES,
  MAX_MERGE_APPROVAL_NOTE_BYTES,
  MERGE_APPROVAL_DECISIONS,
  mergeApprovalNeedsSecondFactor,
  normalizeMergeApprovalChatRef,
  normalizeMergeApprovalHeadSha,
  normalizeMergeApprovalPrNumber,
  normalizeMergeApprovalRepo,
  normalizeMergeApprovalText,
  type MergeApprovalDecision,
  type MergeApprovalDecisionKind,
  type MergeApprovalRequest,
} from "@cocalc/util/merge-approval";
import { readPullRequestHead, readPullRequestSnapshot } from "./github";
import { getMergeApprovalSettings } from "./settings";
import { MergeApprovalStore } from "./store";

const MAX_AGENT_LABEL_LENGTH = 100;

function codeError(message: string, code: string | number): Error {
  return Object.assign(new Error(message), { code });
}

// Approval records and the App key live on the seed bay only. There is no
// route to it from other bays yet, so anywhere else this fails closed.
function assertSeedBay(): void {
  if (getConfiguredBayId() !== getConfiguredClusterSeedBayId()) {
    throw codeError("merge approvals are only available on the seed bay", 409);
  }
}

function store(): MergeApprovalStore {
  return new MergeApprovalStore(getPool());
}

export interface RequestMergeApprovalOptions {
  // Set by the hub from the agent's session token; never from arguments.
  account_id?: string;
  project_id?: string;
  auth_actor?: "agent";
  auth_token_fingerprint?: string;
  // From the agent:
  repo: string;
  pr_number: number;
  head_sha: string;
  note?: string;
  agent_label?: string;
  chat?: { path: string; thread_id?: string; message_date?: string };
}

export async function requestMergeApproval(
  opts: RequestMergeApprovalOptions,
): Promise<MergeApprovalRequest> {
  const { account_id, project_id, auth_actor } = opts;
  if (
    auth_actor !== "agent" ||
    !isValidUUID(account_id) ||
    !isValidUUID(project_id)
  ) {
    throw codeError("merge approvals are requested by an agent session", 403);
  }
  assertSeedBay();
  const settings = await getMergeApprovalSettings();
  if (settings.approvers.length === 0) {
    throw codeError("merge approvals are not enabled", 403);
  }
  // Agent sessions act for the account that runs the agent; only approvers'
  // agents may ask, so nobody else can put requests in front of approvers.
  if (!settings.approvers.includes(account_id!)) {
    throw codeError("this account's agents can't request merge approvals", 403);
  }
  const repo = normalizeMergeApprovalRepo(opts.repo);
  if (!settings.repos.includes(repo)) {
    throw codeError(`merge approvals are not enabled for ${repo}`, 403);
  }
  const pr_number = normalizeMergeApprovalPrNumber(opts.pr_number);
  const head_sha = normalizeMergeApprovalHeadSha(opts.head_sha);
  const agent_note = normalizeMergeApprovalText(
    opts.note,
    MAX_MERGE_APPROVAL_NOTE_BYTES,
    "note",
  );
  const agent_label =
    opts.agent_label == null
      ? undefined
      : `${opts.agent_label}`.trim().slice(0, MAX_AGENT_LABEL_LENGTH) ||
        undefined;
  const chat = normalizeMergeApprovalChatRef(opts.chat, project_id!);
  if (settings.app == null) {
    throw codeError("the merge approval GitHub App is not configured", 503);
  }

  const snapshot = await readPullRequestSnapshot({
    config: settings.app,
    repo,
    pr_number,
  });
  if (snapshot.state !== "open") {
    throw codeError(`pull request #${pr_number} is ${snapshot.state}`, 409);
  }
  if (snapshot.draft) {
    throw codeError(`pull request #${pr_number} is a draft`, 409);
  }
  assertCurrentHead(pr_number, head_sha, snapshot.head_sha);

  const app = settings.app;
  return await store().create(
    {
      repo,
      pr_number,
      head_sha,
      base_ref: snapshot.base_ref,
      github_snapshot: snapshot,
      agent_note,
      requested_by: {
        account_id: account_id!,
        project_id: project_id!,
        token_fingerprint: opts.auth_token_fingerprint,
        agent_label,
      },
      chat,
    },
    {
      // Again under the PR's lock: the head may have moved since the read.
      verify: async () => {
        const now = await readPullRequestHead({ config: app, repo, pr_number });
        if (now.state !== "open" || now.draft) {
          throw codeError(`pull request #${pr_number} changed; try again`, 409);
        }
        assertCurrentHead(pr_number, head_sha, now.head_sha);
      },
    },
  );
}

function assertCurrentHead(
  pr_number: number,
  head_sha: string,
  current: string,
): void {
  if (current !== head_sha) {
    throw Object.assign(
      new Error(
        `pull request #${pr_number} head is ${current}, not ${head_sha}`,
      ),
      { code: "head_mismatch", current_head_sha: current },
    );
  }
}

export interface DecideMergeApprovalOptions {
  // Set by the hub from the browser session; never from arguments.
  account_id?: string;
  session_hash?: string;
  auth_actor?: "agent";
  request_id: string;
  decision: MergeApprovalDecisionKind;
  comment?: string;
}

export async function decideMergeApproval(
  opts: DecideMergeApprovalOptions,
): Promise<{ request: MergeApprovalRequest; decision: MergeApprovalDecision }> {
  const { account_id, session_hash } = opts;
  if (opts.auth_actor === "agent" || !isValidUUID(account_id)) {
    throw codeError("an approver must decide from a browser session", 403);
  }
  assertSeedBay();
  if (!session_hash) {
    throw codeError("human authentication required", "fresh_auth_required");
  }
  const settings = await getMergeApprovalSettings();
  if (!settings.approvers.includes(account_id!)) {
    throw codeError("only merge approvers can decide", 403);
  }
  // The approver's sessions must be here too, so that every check below runs
  // against the records it is about. Fail closed otherwise.
  const account = await getClusterAccountById(account_id!);
  if (account?.home_bay_id !== getConfiguredBayId()) {
    throw codeError(
      "merge approvers must have their home on the seed bay",
      409,
    );
  }
  if (!isValidUUID(opts.request_id)) {
    throw new Error("invalid merge approval request id");
  }
  if (
    !(MERGE_APPROVAL_DECISIONS as readonly string[]).includes(opts.decision)
  ) {
    throw new Error("decision must be approve or reject");
  }
  const comment = normalizeMergeApprovalText(
    opts.comment,
    MAX_MERGE_APPROVAL_COMMENT_BYTES,
    "comment",
  );
  const request = await store().get(opts.request_id);
  if (request == null) {
    throw codeError("merge approval request not found", 404);
  }

  // An admin impersonating the approver is not the approver.
  if (
    await getImpersonationSessionBySessionHash({
      session_hash,
      subject_account_id: account_id!,
    })
  ) {
    throw codeError(
      "merge approvals can't be decided while impersonating",
      "impersonation_blocked",
    );
  }
  // Rejecting only narrows, so it needs a fresh session but no second factor.
  const session = await requireDangerousSessionAuth({
    account_id,
    session_hash,
    require_second_factor:
      opts.decision === "approve" &&
      mergeApprovalNeedsSecondFactor(
        request.repo,
        settings.second_factor_repos,
      ),
    allow_actor_impersonation: false,
  });

  return await store().decide({
    request_id: request.id,
    account_id: account_id!,
    decision: opts.decision,
    comment,
    session_hash: session.session_hash ?? session_hash,
    factor_level: session.factor_level ?? "none",
  });
}
