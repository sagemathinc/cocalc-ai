import { createHash, randomUUID } from "node:crypto";
import {
  AgentAttachmentError,
  validateAttachmentMetadata,
  type AgentSnapshot,
  type AgentSnapshotMetadata,
} from "./attachments";
import { verifyAttachmentPayload } from "./attachments-integrity";
import { AgentRpcCapacity } from "./rpc-capacity";
import type { AgentRpcEnvelope, AgentRpcOutcome } from "./rpc";
import {
  validateAgentRpcOutcome,
  validateAgentRpcRequest,
  validateAgentRpcSource,
  agentRpcSourceKey,
  isExternalAgentSource,
} from "./rpc";
import { requireUuid } from "./protocol";

type Lease = Exclude<ReturnType<AgentRpcCapacity["acquire"]>, { code: string }>;

export interface AttachmentReservationRequest {
  envelope: AgentRpcEnvelope;
  files: AgentSnapshotMetadata[];
}

export interface AttachmentReservation {
  reservation_id: string;
  expires_at: number;
}

export class AttachmentAdmissionError extends Error {
  constructor(
    readonly code:
      | "host_overloaded"
      | "project_overloaded"
      | "attachment_preparation_expired"
      | "attachment_preparation_unavailable",
  ) {
    super(code);
  }
}

interface Entry {
  binding: string;
  request: AttachmentReservationRequest;
  expires: number;
  lease: Lease;
  timer: ReturnType<typeof setTimeout>;
  expired: AbortController;
  state: "starting" | "ready" | "committing";
}

function binding({ envelope: e, files }: AttachmentReservationRequest): string {
  // Permits are independently renewed/checked at the owning bay. Changing a
  // routing permit must not change the actual principal or approved operation.
  return createHash("sha256")
    .update(
      JSON.stringify([
        e.source.project_id,
        e.source.agent_id,
        e.run_id,
        e.account_id,
        e.agent_session_id,
        e.session_generation,
        e.account_generation,
        e.configured_delivery,
        e.target.project_id,
        e.target.agent_id,
        e.path,
        e.thread_id,
        e.attempt_id,
        e.body,
        e.guidance === true,
        files.map(({ name, size, sha256 }) => [name, size, sha256]),
        ...(isExternalAgentSource(e.source)
          ? [agentRpcSourceKey(e.source)]
          : []),
      ]),
    )
    .digest("hex");
}

function snapshot(
  request: AttachmentReservationRequest,
): AttachmentReservationRequest {
  const e = request.envelope;
  validateAgentRpcSource(e.source, e.run_id);
  for (const key of [
    "account_id",
    "agent_session_id",
    "session_generation",
    "permit_id",
    "thread_id",
  ] as const)
    requireUuid(e[key], key);
  if (
    typeof e.path !== "string" ||
    !e.path ||
    e.path.length > 4096 ||
    new TextEncoder().encode(e.path).length > 4096 ||
    /[\x00-\x1f\x7f]/.test(e.path)
  )
    throw new AgentAttachmentError(
      "attachment_invalid",
      "Invalid target chat path",
    );
  validateAttachmentMetadata({ kind: "snapshots", files: request.files });
  validateAgentRpcRequest({
    version: e.version,
    action: "send",
    target: e.target,
    attempt_id: e.attempt_id,
    agent_session_id: e.agent_session_id,
    body: e.body,
  });
  if (e.file_references !== undefined)
    throw new AgentAttachmentError(
      "attachment_invalid",
      "Cannot mix snapshots and live references",
    );
  return {
    envelope: {
      version: e.version,
      body: e.body,
      guidance: e.guidance,
      source: { ...e.source },
      source_label: e.source_label,
      target: { project_id: e.target.project_id, agent_id: e.target.agent_id },
      target_label: e.target_label,
      ...(e.run_id ? { run_id: e.run_id } : {}),
      account_id: e.account_id,
      agent_session_id: e.agent_session_id,
      session_generation: e.session_generation,
      account_generation: e.account_generation,
      configured_delivery: e.configured_delivery,
      permit_id: e.permit_id,
      attempt_id: e.attempt_id,
      thread_id: e.thread_id,
      path: e.path,
      deadline: e.deadline,
      ...(e.snapshot_manifest
        ? { snapshot_manifest: e.snapshot_manifest.map((f) => ({ ...f })) }
        : {}),
      ...(e.attachment_reservation
        ? { attachment_reservation: e.attachment_reservation }
        : {}),
    },
    files: request.files.map(({ name, size, sha256 }) => ({
      name,
      size,
      sha256,
    })),
  };
}

/** Ephemeral host capacity, not delivery storage. No file bytes are retained.
 * No work is started by inspection, expiry or cancellation. Transport handlers
 * must separately bound raw incoming bytes before invoking commit. */
export class AgentAttachmentReservations {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly capacity: AgentRpcCapacity,
    private readonly authorize: (e: AgentRpcEnvelope) => Promise<void>,
    private readonly ensureRunning: (e: AgentRpcEnvelope) => Promise<void>,
  ) {}

  private remove(id: string, entry: Entry) {
    if (this.entries.get(id) !== entry) return;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    entry.lease.release();
    entry.expired.abort();
  }

  private async waitForPreparation(entry: Entry, work: Promise<void>) {
    let expire!: () => void;
    try {
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          expire = () =>
            reject(
              new AttachmentAdmissionError("attachment_preparation_expired"),
            );
          entry.expired.signal.addEventListener("abort", expire, {
            once: true,
          });
          if (entry.expired.signal.aborted) expire();
        }),
      ]);
    } finally {
      entry.expired.signal.removeEventListener("abort", expire);
    }
  }

  private async guard(
    id: string,
    entry: Entry,
    envelope = entry.request.envelope,
  ) {
    const current = () => {
      if (
        this.entries.get(id) !== entry ||
        !Number.isFinite(envelope.deadline) ||
        Date.now() >= entry.expires ||
        Date.now() >= envelope.deadline
      )
        throw new AttachmentAdmissionError("attachment_preparation_expired");
    };
    current();
    await this.authorize(envelope);
    current();
  }

  async prepare(
    request: AttachmentReservationRequest,
  ): Promise<AttachmentReservation> {
    request = snapshot(request);
    if (
      !Number.isFinite(request.envelope.deadline) ||
      request.envelope.deadline <= Date.now()
    )
      throw new AttachmentAdmissionError("attachment_preparation_expired");
    await this.authorize(request.envelope);
    const lease = this.capacity.acquire(request.envelope.target.project_id);
    if ("code" in lease) throw new AttachmentAdmissionError(lease.code);
    const id = randomUUID();
    const expires = Math.min(request.envelope.deadline, Date.now() + 30_000);
    const entry: Entry = {
      binding: binding(request),
      request,
      expires,
      lease,
      state: "starting",
      expired: new AbortController(),
      timer: setTimeout(
        () => this.remove(id, entry),
        Math.max(1, expires - Date.now()),
      ),
    };
    entry.timer.unref?.();
    this.entries.set(id, entry);
    try {
      await this.waitForPreparation(
        entry,
        lease.track(
          (async () => {
            await this.guard(id, entry);
            await this.ensureRunning(request.envelope);
            await this.guard(id, entry);
          })(),
        ),
      );
      entry.state = "ready";
      return { reservation_id: id, expires_at: expires };
    } catch (error) {
      this.remove(id, entry);
      throw error;
    }
  }

  private lookup(id: string, request: AttachmentReservationRequest) {
    validateAttachmentMetadata({ kind: "snapshots", files: request.files });
    const entry = this.entries.get(id);
    if (!entry || entry.state !== "ready" || entry.binding !== binding(request))
      throw new AttachmentAdmissionError("attachment_preparation_unavailable");
    return entry;
  }

  async cancel(
    id: string,
    request: AttachmentReservationRequest,
  ): Promise<void> {
    request = snapshot(request);
    const entry = this.lookup(id, request);
    await this.guard(id, entry, request.envelope);
    // A commit may have claimed this entry while authorization was pending.
    if (entry.state !== "ready")
      throw new AttachmentAdmissionError("attachment_preparation_unavailable");
    this.remove(id, entry);
  }

  async commit<T>(
    id: string,
    request: AttachmentReservationRequest,
    files: AgentSnapshot[],
    adapter: {
      /** Must remove partial files itself if staging throws. */
      stage(files: AgentSnapshot[]): Promise<T>;
      submit(staged: T): Promise<AgentRpcOutcome>;
      discard(staged: T): Promise<void>;
    },
  ): Promise<AgentRpcOutcome> {
    request = snapshot(request);
    const entry = this.lookup(id, request);
    // Claim synchronously before any await; duplicate commits cannot write twice.
    entry.state = "committing";
    try {
      return await entry.lease.track(
        (async () => {
          const guard = () => this.guard(id, entry, request.envelope);
          await guard();
          verifyAttachmentPayload(
            { kind: "snapshots", files: entry.request.files },
            files,
          );
          await guard();
          const staged = await adapter.stage(files);
          try {
            await guard();
          } catch (error) {
            await adapter.discard(staged);
            throw error;
          }
          // Once submission begins, exceptions and invalid/lost acknowledgments
          // are ambiguous. Keep the staged files for any possibly accepted work.
          const outcome = await adapter.submit(staged);
          validateAgentRpcOutcome(outcome, request.envelope);
          if (outcome.outcome === "rejected" && outcome.chat_effect === "none")
            await adapter.discard(staged);
          return outcome;
        })(),
      );
    } finally {
      this.remove(id, entry);
    }
  }

  close(): void {
    for (const [id, entry] of this.entries) this.remove(id, entry);
  }
}
