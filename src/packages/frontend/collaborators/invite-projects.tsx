/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useId, useRef, useState } from "react";
import { Button, Checkbox, Input } from "antd";
import type {
  PeopleInvitationOperation,
  PeopleInvitationReview,
  PeopleInvitationTarget,
  PeopleInvitationPayload,
} from "@cocalc/util/people-invitations";
import { PEOPLE_INVITATION_LIMITS } from "@cocalc/util/people-invitations";
import { is_valid_email_address, uuid } from "@cocalc/util/misc";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import type { CollaboratorInvitePerson } from "./add-collaborators";
import type {
  InvitationApi,
  InvitationDiscoveryApi,
  InvitationProject,
  InvitationRecipient,
  InviteProjectsDraft,
} from "./invitation-api";
import { boundInvitationsApi } from "./invitations-api";
import { defaultProjectChoice, recipientKey } from "./invitation-choices";
import { InvitationProjectsTable } from "./invitation-projects-table";
import {
  InvitationReviewDetails,
  InvitationResults,
} from "./invitation-review";
import { notifyCollabInvitesChanged } from "./invite-events";
import { CollaboratorsModal } from "./modal";

export type { InviteProjectsDraft, InvitationApi } from "./invitation-api";

export interface InviteProjectsProps {
  initialProjectIds?: string[];
  initialDraft?: InviteProjectsDraft;
  createdProjectId?: string;
  person?: CollaboratorInvitePerson;
  target?: PeopleInvitationTarget;
  api?: InvitationApi;
  discoveryApi?: InvitationDiscoveryApi;
  onClose: () => void;
  onCreateProject?: (
    selectedProjectIds: string[],
    draftState: InviteProjectsDraft,
  ) => void;
  onSent?: (operation: PeopleInvitationOperation) => void;
}

function initialRecipient(
  person?: CollaboratorInvitePerson,
): InvitationRecipient | undefined {
  if (person?.account_id)
    return {
      kind: "account",
      account_id: person.account_id,
      label:
        person.display_name ||
        [person.first_name, person.last_name].filter(Boolean).join(" ") ||
        person.account_id,
    };
  if (person?.email_address)
    return {
      kind: "email",
      email_address: person.email_address,
      label: person.email_address,
    };
}

/** Creation hands off editable intent, never a reusable review authorization. */
export function InviteProjects({
  initialProjectIds = [],
  initialDraft,
  createdProjectId,
  person,
  target,
  api: suppliedApi,
  discoveryApi,
  onClose,
  onCreateProject,
  onSent,
}: InviteProjectsProps) {
  const [api] = useState<InvitationApi>(
    () => suppliedApi ?? boundInvitationsApi(webapp_client.account_id ?? ""),
  );
  const discovery = discoveryApi ?? api;
  const [draft, setDraft] = useState<InviteProjectsDraft>(() => ({
    recipientQuery: initialDraft?.recipientQuery ?? "",
    recipient: initialDraft?.recipient ?? initialRecipient(person),
    projects: initialDraft?.projects ?? [],
    message: initialDraft?.message ?? "",
    target: initialDraft?.target ?? target,
    channels: initialDraft?.channels ?? { notification: true, email: true },
    createdProjectIds: Array.from(
      new Set([
        ...(initialDraft?.createdProjectIds ?? []),
        ...(createdProjectId ? [createdProjectId] : []),
      ]),
    ),
  }));
  const [step, setStep] = useState<
    "person" | "projects" | "review" | "results"
  >("person");
  const [matches, setMatches] = useState<InvitationRecipient[]>([]);
  const [rows, setRows] = useState<InvitationProject[]>([]);
  const [knownRows, setKnownRows] = useState<Record<string, InvitationProject>>(
    {},
  );
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<PeopleInvitationReview>();
  const [expired, setExpired] = useState(false);
  const [operation, setOperation] = useState<PeopleInvitationOperation>();
  const [unknownSend, setUnknownSend] = useState(false);
  const [inspected, setInspected] = useState(false);
  const [previousOperations, setPreviousOperations] = useState<
    PeopleInvitationOperation[]
  >([]);
  const [returnFocus] = useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined,
  );
  const mounted = useRef(true);
  const pending = useRef(false);
  const request = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusedStep = useRef(step);
  const session = useRef({ draftId: uuid(), revision: 0, sendKey: uuid() });
  const initialIds = useRef(
    Array.from(
      new Set([
        ...initialProjectIds,
        ...(target ? [target.project_id] : []),
        ...(createdProjectId ? [createdProjectId] : []),
      ]),
    ).slice(0, PEOPLE_INVITATION_LIMITS.projects),
  );
  const inputId = useId();
  const messageId = useId();
  const searchId = useId();
  const targetMissing =
    !!draft.target &&
    !draft.projects.some(
      ({ project_id }) => project_id === draft.target?.project_id,
    );
  const submissionBusy = busy && step === "results";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, []);
  useEffect(() => {
    if (focusedStep.current !== step) heading.current?.focus();
    focusedStep.current = step;
  }, [step]);
  useEffect(() => {
    setExpired(false);
    if (!review) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, review.expires_at - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [review]);

  function close() {
    if (pending.current && step === "results") return;
    onClose();
    requestAnimationFrame(() => {
      if (returnFocus?.isConnected && document.activeElement === document.body)
        returnFocus.focus({ preventScroll: true });
    });
  }

  function edit(patch: Partial<InviteProjectsDraft>) {
    setReview(undefined);
    setDraft((previous) => ({ ...previous, ...patch }));
    setError("");
  }

  async function searchRecipients() {
    const value = draft.recipientQuery.trim();
    if (!value || pending.current) return;
    const id = ++request.current;
    setMatches([]);
    setError("");
    setNotice("");
    // An email stays an email specification, even if an account happens to exist.
    if (is_valid_email_address(value)) {
      setMatches([{ kind: "email", email_address: value, label: value }]);
      return;
    }
    if (!discovery.resolveRecipient) {
      setError(
        "Recipient search is unavailable on this server. You can still enter an email address.",
      );
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      const result = await discovery.resolveRecipient({ query: value });
      if (!mounted.current || id !== request.current) return;
      setMatches(result.recipients);
      setNotice(
        result.notice ??
          (result.recipients.length
            ? "Choose the intended person. Names can match more than one account."
            : "No matching people. An email address can be invited without an account."),
      );
    } catch (err) {
      if (mounted.current && id === request.current) setError(String(err));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function loadProjects(
    recipient: InvitationRecipient,
    options: { next?: string; search?: string; choose?: boolean } = {},
  ) {
    if (pending.current) return;
    if (!discovery.listProjects) {
      setError(
        "Project invitation status is unavailable on this server. No invitations have been sent.",
      );
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    const id = ++request.current;
    try {
      const result = await discovery.listProjects({
        recipient,
        query: options.search ?? query,
        cursor: options.next,
        project_ids: options.choose ? initialIds.current : undefined,
        target: draft.target,
      });
      if (!mounted.current || id !== request.current) return;
      setRows(result.projects);
      setKnownRows((previous) => ({
        ...previous,
        ...Object.fromEntries(
          result.projects.map((row) => [row.project_id, row]),
        ),
      }));
      setCursor(result.next_cursor);
      setNotice(result.notice ?? "");
      if (options.choose) {
        const same =
          draft.recipient &&
          recipientKey(draft.recipient) === recipientKey(recipient);
        const selected = same ? [...draft.projects] : [];
        for (const projectId of initialIds.current) {
          if (selected.some((choice) => choice.project_id === projectId))
            continue;
          const row = result.projects.find(
            (project) => project.project_id === projectId,
          );
          const choice = row && defaultProjectChoice(row);
          if (choice && selected.length < PEOPLE_INVITATION_LIMITS.projects)
            selected.push(choice);
        }
        const next = { ...draft, recipient, projects: selected };
        edit({ recipient, projects: selected });
        setStep("projects");
        const source = result.projects.find(
          (row) => row.project_id === draft.target?.project_id,
        );
        if (
          draft.target &&
          source?.can_notify &&
          source.content_access === "allowed" &&
          selected.length === 1 &&
          selected[0].action === "notify"
        ) {
          pending.current = false;
          await prepare(next);
        }
      }
    } catch (err) {
      if (mounted.current && id === request.current) setError(String(err));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function prepare(value = draft) {
    if (pending.current || !value.recipient || !value.projects.length) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setReview(undefined);
    try {
      const { recipient } = value;
      const payload: PeopleInvitationPayload = {
        recipient:
          recipient.kind === "email"
            ? {
                kind: "email",
                email_address: recipient.email_address,
                person_id: recipient.person_id,
              }
            : {
                kind: "account",
                account_id: recipient.account_id,
                person_id: recipient.person_id,
              },
        projects: value.projects,
        target: value.target,
        message: value.message,
        channels: value.channels,
      };
      const prepared = await api.prepareInvitation({
        draft_id: session.current.draftId,
        expected_revision: session.current.revision,
        payload,
      });
      session.current.revision = prepared.revision;
      if (!mounted.current) return;
      const reviewed = await api.reviewInvitation({
        draft_id: prepared.draft_id,
        revision: prepared.revision,
      });
      if (!mounted.current) return;
      setReview(reviewed);
      setStep("review");
    } catch (err) {
      if (mounted.current) setError(String(err));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function recordOperation(result: PeopleInvitationOperation) {
    setOperation(result);
    setUnknownSend(false);
    for (const outcome of result.outcomes)
      notifyCollabInvitesChanged(outcome.project_id);
    onSent?.(result);
  }

  async function send() {
    if (
      !review ||
      expired ||
      Date.now() >= review.expires_at ||
      pending.current
    )
      return;
    pending.current = true;
    setBusy(true);
    setError("");
    setStep("results");
    try {
      const result = await api.sendInvitation({
        draft_id: review.draft.draft_id,
        revision: review.draft.revision,
        review_id: review.review_id,
        idempotency_key: session.current.sendKey,
      });
      if (mounted.current) recordOperation(result);
    } catch (err) {
      if (mounted.current) {
        setUnknownSend(true);
        setError(
          `Send outcome unknown. Do not create a new invitation to retry. ${String(err)}`,
        );
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function inspect() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api.getInvitationOperation({
        // The service's durable operation ID is the caller's idempotency key.
        operation_id: operation?.operation_id ?? session.current.sendKey,
      });
      if (mounted.current) recordOperation(result);
    } catch (err) {
      if (mounted.current) setError(String(err));
    } finally {
      pending.current = false;
      if (mounted.current) {
        setBusy(false);
        setInspected(true);
      }
    }
  }

  function reviewFailedProjects() {
    if (!operation || pending.current) return;
    const failed = new Set(
      operation.outcomes
        .filter(
          (outcome) =>
            outcome.status === "failed" || outcome.status === "review_required",
        )
        .map(({ project_id }) => project_id),
    );
    const projects = operation.payload.projects.filter(({ project_id }) =>
      failed.has(project_id),
    );
    if (!projects.length) return;
    setPreviousOperations((previous) => [...previous, operation]);
    initialIds.current = projects.map(({ project_id }) => project_id);
    session.current = { draftId: uuid(), revision: 0, sendKey: uuid() };
    edit({
      projects,
      target:
        draft.target && failed.has(draft.target.project_id)
          ? draft.target
          : undefined,
    });
    setOperation(undefined);
    setUnknownSend(false);
    setInspected(false);
    setStep("projects");
  }

  return (
    <CollaboratorsModal
      open
      title="Invite a person"
      onCancel={close}
      closable={!submissionBusy}
      keyboard={!submissionBusy}
      mask={{ closable: false }}
      width={760}
      afterOpenChange={(open) => {
        const active = document.activeElement;
        if (
          open &&
          (active === document.body ||
            active?.getAttribute("role") === "dialog")
        )
          heading.current?.focus();
      }}
      footer={
        <Button disabled={submissionBusy} onClick={close}>
          Close
        </Button>
      }
    >
      <KeyboardBoundary
        boundary="collaborators-invite-projects"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
      >
        <h2 ref={heading} tabIndex={-1} style={{ fontSize: 18 }}>
          {step === "person"
            ? "Choose person"
            : step === "projects"
              ? "Choose projects"
              : step === "review"
                ? "Review invitation"
                : "Invitation results"}
        </h2>
        {draft.createdProjectIds.length > 0 && (
          <section aria-label="Created projects">
            <p>
              These projects were created and will remain even if you close or
              invitations fail. No content was copied.
            </p>
            <ul>
              {draft.createdProjectIds.map((id) => (
                <li key={id}>{knownRows[id]?.title ?? id}</li>
              ))}
            </ul>
          </section>
        )}
        {error && <p role="alert">{error}</p>}
        <p role="status">{busy ? "Working..." : notice}</p>
        {previousOperations.map((previous) => (
          <InvitationResults
            key={previous.operation_id}
            operation={previous}
            projects={knownRows}
          />
        ))}
        {step === "person" && (
          <>
            <p>
              Choose one person by email, name, or exact public @username. A
              public username is not a personal alias.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void searchRecipients();
              }}
            >
              <label htmlFor={inputId}>Email, name, or @username</label>
              <Input
                id={inputId}
                value={draft.recipientQuery}
                maxLength={254}
                disabled={busy}
                autoComplete="off"
                onChange={(event) => {
                  request.current++;
                  setMatches([]);
                  edit({ recipientQuery: event.target.value });
                }}
              />
              <Button
                htmlType="submit"
                disabled={busy || !draft.recipientQuery.trim()}
              >
                Find person
              </Button>
            </form>
            {draft.recipient && (
              <p>
                Selected: <strong>{draft.recipient.label}</strong>{" "}
                <Button
                  disabled={busy}
                  onClick={() =>
                    void loadProjects(draft.recipient!, { choose: true })
                  }
                >
                  Continue with {draft.recipient.label}
                </Button>
              </p>
            )}
            <ul aria-label="Matching people">
              {matches.map((recipient) => (
                <li key={recipientKey(recipient)}>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void loadProjects(recipient, { choose: true })
                    }
                  >
                    Choose {recipient.label}
                    {recipient.username ? ` (@${recipient.username})` : ""}
                  </Button>
                  {recipient.kind === "account" && (
                    <span> Account: {recipient.account_id}</span>
                  )}
                  {recipient.kind === "email" && (
                    <span>
                      {" "}
                      Email invitation; account membership is unknown.
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {step === "projects" && (
          <>
            <p>
              Recipient: <strong>{draft.recipient?.label}</strong>
            </p>
            <Button
              disabled={busy}
              onClick={() => {
                setStep("person");
                setNotice("");
              }}
            >
              Change person
            </Button>
            {draft.target && (
              <section aria-label="Content invitation">
                <h3>{draft.target.label ?? draft.target.kind}</h3>
                <p>
                  Source project:{" "}
                  {knownRows[draft.target.project_id]?.title ??
                    draft.target.project_id}
                  . Inviting to another project does not copy this content or
                  grant access to it.
                </p>
                <Button
                  disabled={busy}
                  onClick={() => edit({ target: undefined })}
                >
                  Remove content context
                </Button>
              </section>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (draft.recipient)
                  void loadProjects(draft.recipient, { search: query });
              }}
            >
              <label htmlFor={searchId}>Search projects</label>
              <Input
                id={searchId}
                value={query}
                disabled={busy}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Button htmlType="submit" disabled={busy}>
                Search projects
              </Button>
            </form>
            <InvitationProjectsTable
              rows={rows}
              knownRows={knownRows}
              choices={draft.projects}
              disabled={busy}
              onChange={(projects) => edit({ projects })}
            />
            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                marginBlock: 12,
              }}
            >
              <Button
                disabled={busy}
                onClick={() =>
                  draft.recipient && void loadProjects(draft.recipient)
                }
              >
                Refresh projects
              </Button>
              {cursor && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    draft.recipient &&
                    void loadProjects(draft.recipient, { next: cursor })
                  }
                >
                  Next projects
                </Button>
              )}
              {onCreateProject && (
                <Button
                  disabled={
                    busy ||
                    draft.projects.length >= PEOPLE_INVITATION_LIMITS.projects
                  }
                  onClick={() =>
                    onCreateProject(
                      draft.projects.map(({ project_id }) => project_id),
                      draft,
                    )
                  }
                >
                  Create a new project together
                </Button>
              )}
            </div>
            {onCreateProject && (
              <p>
                Creation is a separate action. The new project belongs to you;
                this person remains pending until accepting an invitation.
                Nothing is copied.
              </p>
            )}
          </>
        )}
        {(step === "projects" || step === "review") && (
          <>
            {targetMissing && (
              <p role="alert">
                The selected content stays in its source project. Select that
                project or remove the content context before reviewing; another
                project does not grant access to this content.
              </p>
            )}
            <label htmlFor={messageId}>Invitation message</label>
            <Input.TextArea
              id={messageId}
              value={draft.message}
              maxLength={PEOPLE_INVITATION_LIMITS.message}
              autoSize={{ minRows: 3, maxRows: 8 }}
              disabled={busy}
              onChange={(event) => edit({ message: event.target.value })}
            />
            <fieldset disabled={busy} style={{ marginBlock: 12 }}>
              <legend>Delivery channels</legend>
              <Checkbox
                checked={draft.channels.notification}
                onChange={(event) =>
                  edit({
                    channels: {
                      ...draft.channels,
                      notification: event.target.checked,
                    },
                  })
                }
              >
                In-app notification
              </Checkbox>
              <Checkbox
                checked={draft.channels.email}
                onChange={(event) =>
                  edit({
                    channels: {
                      ...draft.channels,
                      email: event.target.checked,
                    },
                  })
                }
              >
                Email
              </Checkbox>
            </fieldset>
            {step === "review" && (
              <Button
                disabled={busy}
                onClick={() => {
                  setReview(undefined);
                  setStep("projects");
                }}
              >
                Change projects or content
              </Button>
            )}
            {review && (
              <InvitationReviewDetails
                review={review}
                recipientLabel={draft.recipient?.label}
                projects={knownRows}
              />
            )}
            {expired && review && (
              <p role="alert">Review expired. Review again before sending.</p>
            )}
            {!review || expired ? (
              <Button
                type="primary"
                disabled={
                  busy ||
                  targetMissing ||
                  !draft.projects.length ||
                  (!draft.channels.email && !draft.channels.notification)
                }
                onClick={() => void prepare()}
              >
                Review exact invitation
              </Button>
            ) : (
              <Button
                type="primary"
                disabled={busy}
                onClick={() => void send()}
              >
                Send reviewed invitation
              </Button>
            )}
            <p>
              No invitations or notifications are sent until you choose Send
              reviewed invitation.
            </p>
          </>
        )}
        {step === "results" && (
          <>
            {operation && (
              <InvitationResults operation={operation} projects={knownRows} />
            )}
            {(operation || unknownSend) && (
              <Button disabled={busy} onClick={() => void inspect()}>
                Check delivery and operation status
              </Button>
            )}
            {unknownSend && (
              <p>
                Keep this recovery key: <code>{session.current.sendKey}</code>.
                Check status before retrying. A retry uses the same reviewed
                operation and cannot repeat successful actions.
              </p>
            )}
            {unknownSend && inspected && !expired && (
              <Button disabled={busy} onClick={() => void send()}>
                Retry same reviewed send
              </Button>
            )}
            {operation?.outcomes.some(
              (outcome) =>
                outcome.status === "failed" ||
                outcome.status === "review_required",
            ) && (
              <Button disabled={busy} onClick={reviewFailedProjects}>
                Review failed projects only
              </Button>
            )}
          </>
        )}
      </KeyboardBoundary>
    </CollaboratorsModal>
  );
}
