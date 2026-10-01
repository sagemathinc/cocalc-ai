/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PoolClient } from "@cocalc/database/pool";
import {
  normalizePeopleInvitationPayload,
  peopleInvitationUuid,
} from "@cocalc/util/people-invitations";
import type {
  PeopleInvitationPayload,
  PeopleInvitationPreflight,
  PeopleInvitationProjectAction,
  PeopleInvitationActionReceipt,
  PeopleInvitationOperation,
  PreparePeopleInvitationInput,
  ReviewPeopleInvitationInput,
  SendPeopleInvitationInput,
} from "@cocalc/util/people-invitations";
import { PeopleInvitationStore } from "./invitations-store";
import { peopleCollaborationInvitationId } from "./invitations-identity";

/** Trusted service implementations only. Never accept any of these from RPC input. */
export interface PeopleInvitationServices {
  refreshDelivery(operation: PeopleInvitationOperation): Promise<void>;
  authorizeHome(account_id: string): Promise<void>;
  preflight(
    account_id: string,
    payload: PeopleInvitationPayload,
    action: PeopleInvitationProjectAction,
  ): Promise<PeopleInvitationPreflight>;
  /** undefined means authoritatively not admitted, never a timeout/not-found guess. */
  inspectAccess(input: {
    account_id: string;
    child_operation_id: string;
    payload: PeopleInvitationPayload;
    action: PeopleInvitationProjectAction;
  }): Promise<PeopleInvitationActionReceipt | undefined>;
  executeAccess(input: {
    account_id: string;
    child_operation_id: string;
    payload: PeopleInvitationPayload;
    action: PeopleInvitationProjectAction;
    authorization_expires_at: number;
  }): Promise<PeopleInvitationActionReceipt>;
  /** Resolve routing before the transaction; returned function makes only local writes. */
  prepareDelivery(
    operation: PeopleInvitationOperation,
  ): Promise<
    (db: PoolClient, operation: PeopleInvitationOperation) => Promise<void>
  >;
  /** Idempotent home contact/history reconciliation; failure retains durable work. */
  projectOutcome(operation: PeopleInvitationOperation): Promise<void>;
}

function revision(value: number) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw Error("invalid invitation revision");
}
function session(value: string) {
  if (typeof value !== "string" || !value)
    throw Error("human session required");
}
export function invitationReviewRequired(): Error {
  return Object.assign(Error("Invitation changed: review required"), {
    code: "invitation_review_required",
  });
}
function requiresReview(error: unknown): boolean {
  return (error as { code?: string })?.code === "invitation_review_required";
}

/** Account-home orchestration. Project authority is always delegated to owner routing. */
export class PeopleInvitationService {
  constructor(
    private store: PeopleInvitationStore,
    private services: PeopleInvitationServices,
  ) {}

  private async check(account_id: string) {
    peopleInvitationUuid(account_id, "authenticated account_id");
    await this.services.authorizeHome(account_id);
    await this.store.ensureSchema();
  }
  private async preflight(
    account_id: string,
    payload: PeopleInvitationPayload,
  ) {
    if (
      payload.recipient.kind === "account" &&
      payload.recipient.account_id === account_id
    )
      throw Error("cannot invite yourself");
    const results: PeopleInvitationPreflight[] = [];
    for (const action of payload.projects) {
      const result = await this.services.preflight(account_id, payload, action);
      if (
        result.project_id !== action.project_id ||
        result.action !== action.action ||
        (action.action === "notify" && result.recipient_access !== "sufficient")
      )
        throw invitationReviewRequired();
      results.push(result);
    }
    return results;
  }

  async prepare(
    account_id: string,
    input: PreparePeopleInvitationInput,
    session_hash: string,
  ) {
    session(session_hash);
    const draft_id = peopleInvitationUuid(input.draft_id, "draft_id");
    if (
      !Number.isSafeInteger(input.expected_revision) ||
      input.expected_revision < 0
    )
      throw Error("invalid expected_revision");
    const payload = normalizePeopleInvitationPayload(input.payload);
    await this.check(account_id);
    const preflight = await this.preflight(account_id, payload);
    return this.store.prepare(
      account_id,
      draft_id,
      input.expected_revision,
      payload,
      preflight,
    );
  }

  async review(
    account_id: string,
    input: ReviewPeopleInvitationInput,
    session_hash: string,
  ) {
    session(session_hash);
    revision(input.revision);
    const draft_id = peopleInvitationUuid(input.draft_id, "draft_id");
    await this.check(account_id);
    return this.store.review(
      account_id,
      draft_id,
      input.revision,
      session_hash,
      async (draft) => {
        const checks = await this.preflight(account_id, draft.payload);
        if (
          checks.some(
            (r, i) =>
              r.recipient_access !== draft.preflight[i]?.recipient_access,
          )
        )
          throw invitationReviewRequired();
      },
    );
  }

  async send(
    account_id: string,
    input: SendPeopleInvitationInput,
    session_hash: string,
  ) {
    session(session_hash);
    revision(input.revision);
    const normalized = {
      ...input,
      draft_id: peopleInvitationUuid(input.draft_id, "draft_id"),
      review_id: peopleInvitationUuid(input.review_id, "review_id"),
      idempotency_key: peopleInvitationUuid(
        input.idempotency_key,
        "idempotency_key",
      ),
    };
    await this.check(account_id);
    const admitted = await this.store.admit(
      account_id,
      normalized,
      session_hash,
    );
    // Admission is a result in its own right. A disconnected caller never loses the job.
    await this.run(account_id, admitted.operation_id);
    const operation = await this.store.operation(
      account_id,
      admitted.operation_id,
    );
    await this.services.refreshDelivery(operation);
    return operation;
  }

  async status(account_id: string, operation_id: string, session_hash: string) {
    session(session_hash);
    peopleInvitationUuid(operation_id, "operation_id");
    await this.check(account_id);
    const operation = await this.store.operation(account_id, operation_id);
    await this.services.refreshDelivery(operation);
    return operation;
  }

  async run(account_id: string, operation_id: string): Promise<void> {
    await this.check(account_id);
    const claim = await this.store.claim(account_id, operation_id);
    if (!claim) return;
    const { operation, lease_id } = claim;
    operation.status = "running";
    await this.store.save(operation, lease_id, false);
    for (let i = 0; i < operation.outcomes.length; i++) {
      const receipt = operation.outcomes[i];
      if (receipt.status !== "pending" && receipt.status !== "unknown")
        continue;
      const action = operation.payload.projects[i];
      try {
        await this.services.authorizeHome(account_id);
        if (action.action === "offer_access") {
          // Inspect first even for pending: a process can die after the remote commit
          // but before persisting its home receipt. Never infer failure from a timeout.
          const previous = await this.services.inspectAccess({
            account_id,
            child_operation_id: receipt.child_operation_id,
            payload: operation.payload,
            action,
          });
          if (previous) {
            if (
              previous.child_operation_id !== receipt.child_operation_id ||
              previous.project_id !== receipt.project_id ||
              previous.action !== action.action
            )
              throw Error("invalid owner receipt");
            operation.outcomes[i] = previous;
            await this.store.save(operation, lease_id, false);
            continue;
          }
        }
        if (Date.now() >= operation.authorization_expires_at)
          throw invitationReviewRequired();
        const check = await this.services.preflight(
          account_id,
          operation.payload,
          action,
        );
        if (
          check.action !== action.action ||
          check.project_id !== action.project_id ||
          (action.action === "notify" &&
            check.recipient_access !== "sufficient")
        )
          throw invitationReviewRequired();
        if (action.action === "offer_access") {
          const result = await this.services.executeAccess({
            account_id,
            child_operation_id: receipt.child_operation_id,
            payload: operation.payload,
            action,
            authorization_expires_at: operation.authorization_expires_at,
          });
          if (
            result.child_operation_id !== receipt.child_operation_id ||
            result.project_id !== receipt.project_id ||
            result.action !== action.action
          )
            throw Error("invalid owner receipt");
          operation.outcomes[i] = result;
        } else {
          // This marks an authorized permission-free intent, not delivery success.
          receipt.status = "notified";
          receipt.collaboration_invitation_id = peopleCollaborationInvitationId(
            operation.operation_id,
            receipt.child_operation_id,
          );
        }
      } catch (error) {
        receipt.status = requiresReview(error) ? "review_required" : "unknown";
        receipt.reason = requiresReview(error)
          ? "review_required"
          : "owner_outcome_unconfirmed";
      }
      await this.store.save(operation, lease_id, false);
    }
    const unknown = operation.outcomes.some(
      (r) => r.status === "unknown" || r.status === "pending",
    );
    const successful = operation.outcomes.filter((r) =>
      ["created", "reused", "notified"].includes(r.status),
    );
    operation.status = unknown
      ? "unknown"
      : successful.length === operation.outcomes.length
        ? "complete"
        : "partial";
    if (unknown) {
      try {
        await this.services.projectOutcome(operation);
      } catch {
        /* The pending job retries projection too. */
      }
      await this.store.save(operation, lease_id, true, true);
      return;
    }
    try {
      // Access offers may already exist even if subsequent notification delivery fails.
      await this.services.projectOutcome(operation);
      // Delivery itself is idempotent and shares a transaction with its receipts.
      // Once queued, retries must not require access that might since have changed.
      if (
        successful.some(
          (r) => !r.collaboration_invitation_id || !r.delivery.length,
        )
      ) {
        const delivery = await this.services.prepareDelivery(operation);
        await this.store.save(operation, lease_id, false, false, delivery);
      }
      await this.services.projectOutcome(operation);
      await this.store.save(operation, lease_id, true);
    } catch (error) {
      if (requiresReview(error)) {
        for (const outcome of successful) {
          if (outcome.action === "notify" && !outcome.delivery.length) {
            outcome.status = "review_required";
            outcome.reason = "review_required";
            delete outcome.collaboration_invitation_id;
          } else if (!outcome.delivery.length) {
            outcome.delivery = [
              {
                channel: "notification",
                status: "suppressed",
                reason: "review_required",
              },
              {
                channel: "email",
                status: "suppressed",
                reason: "review_required",
              },
            ];
          }
        }
      }
      operation.status = "partial";
      await this.store.save(operation, lease_id, true, !requiresReview(error));
    }
  }

  async maintenance() {
    await this.store.ensureSchema();
    const jobs = await this.store.pending(8);
    for (const job of jobs) {
      try {
        await this.run(job.account_id, job.operation_id);
      } catch {
        /* Durable claim expires; another pass re-resolves account home. */
      }
    }
  }
}
