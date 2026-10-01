/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useId, useRef, useState } from "react";
import {
  Alert,
  Avatar,
  Button,
  Checkbox,
  Input,
  Radio,
  Space,
  Steps,
  Typography,
} from "antd";
import type { InputRef } from "antd";
import "./invite-projects.css";
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
  const [candidate, setCandidate] = useState(draft.recipient);
  const [searchBusy, setSearchBusy] = useState(false);
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
  const personInput = useRef<InputRef>(null);
  const projectInput = useRef<InputRef>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
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
    if (focusedStep.current !== step) focusStep();
    focusedStep.current = step;
  }, [step]);
  useEffect(() => {
    if (step !== "person" || !draft.recipientQuery.trim()) return;
    searchTimer.current = setTimeout(() => void searchRecipients(), 300);
    return () => clearTimeout(searchTimer.current);
  }, [draft.recipientQuery, step]);
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

  function focusStep() {
    if (step === "person") personInput.current?.focus();
    else if (step === "projects") projectInput.current?.focus();
    else heading.current?.focus();
  }

  function edit(patch: Partial<InviteProjectsDraft>) {
    setReview(undefined);
    setDraft((previous) => ({ ...previous, ...patch }));
    setError("");
  }

  async function searchRecipients() {
    clearTimeout(searchTimer.current);
    const value = draft.recipientQuery.trim();
    if (!value || pending.current) return;
    const id = ++request.current;
    setMatches([]);
    setSearchBusy(false);
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
    setSearchBusy(true);
    try {
      const result = await discovery.resolveRecipient({ query: value });
      if (!mounted.current || id !== request.current) return;
      setMatches(result.recipients);
      setNotice(
        result.notice ??
          (result.recipients.length
            ? ""
            : "No matching people. An email address can be invited without an account."),
      );
    } catch (err) {
      if (mounted.current && id === request.current) setError(String(err));
    } finally {
      if (mounted.current && id === request.current) setSearchBusy(false);
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
    setSearchBusy(false);
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
      setDraft((previous) => ({
        ...previous,
        message: reviewed.draft.payload.message,
        channels: reviewed.draft.payload.channels,
      }));
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

  const reviewDisabled =
    busy ||
    targetMissing ||
    !draft.projects.length ||
    (!draft.channels.email && !draft.channels.notification);
  const back = () => {
    setReview(undefined);
    setNotice("");
    setStep(step === "projects" ? "person" : "projects");
  };
  const recipients =
    candidate &&
    !matches.some((r) => recipientKey(r) === recipientKey(candidate))
      ? [candidate, ...matches]
      : matches;

  return (
    <CollaboratorsModal
      open
      title="Invite a person"
      rootClassName="invitation-modal"
      onCancel={close}
      closable={!submissionBusy}
      keyboard={!submissionBusy}
      mask={{ closable: false }}
      width={step === "projects" ? 880 : 640}
      styles={{ body: { maxHeight: "min(68vh, 720px)", overflowY: "auto" } }}
      afterOpenChange={(open) => {
        if (open) focusStep();
      }}
      footer={
        <div className="invitation-footer">
          <Button
            disabled={submissionBusy || (busy && step !== "person")}
            onClick={step === "person" || step === "results" ? close : back}
          >
            {step === "person"
              ? "Cancel"
              : step === "results"
                ? "Done"
                : "Back"}
          </Button>
          <div className="invitation-footer-actions">
            {step === "projects" && (
              <Typography.Text type="secondary" role="status">
                {draft.projects.length} / {PEOPLE_INVITATION_LIMITS.projects}{" "}
                selected
              </Typography.Text>
            )}
            {step === "person" && (
              <Button
                type="primary"
                loading={busy}
                disabled={!candidate || busy}
                onClick={() =>
                  candidate && void loadProjects(candidate, { choose: true })
                }
              >
                Next: Choose projects
              </Button>
            )}
            {(step === "projects" || step === "review") &&
              (!review || expired ? (
                <Button
                  key="review"
                  type="primary"
                  loading={busy}
                  disabled={reviewDisabled}
                  onClick={() => void prepare()}
                >
                  {step === "review" ? "Review again" : "Review invitation"}
                </Button>
              ) : (
                <Button
                  key="send"
                  type="primary"
                  disabled={busy}
                  onClick={() => void send()}
                >
                  Send invitation
                </Button>
              ))}
            {step === "results" && (
              <Button
                type="primary"
                disabled={submissionBusy}
                onClick={async () => {
                  close();
                  const { openCollaborators } = await import("./navigation");
                  openCollaborators({ view: "invites" });
                }}
              >
                View invitations
              </Button>
            )}
          </div>
        </div>
      }
    >
      <KeyboardBoundary
        boundary="collaborators-invite-projects"
        className="invitation-workflow"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
      >
        <Steps
          className="invitation-steps"
          size="small"
          current={["person", "projects", "review", "results"].indexOf(step)}
          items={[
            { title: "Person" },
            { title: "Projects" },
            { title: "Review" },
          ]}
        />
        <Typography.Text type="secondary" className="invitation-progress">
          {step === "results"
            ? "Results"
            : `Step ${["person", "projects", "review"].indexOf(step) + 1} of 3`}
        </Typography.Text>
        <h2 ref={heading} tabIndex={-1} className="invitation-heading">
          {step === "person"
            ? "Choose person"
            : step === "projects"
              ? "Choose projects"
              : step === "review"
                ? "Review invitation"
                : "Invitation results"}
        </h2>
        {draft.createdProjectIds.length > 0 && (
          <Alert
            role="note"
            type="info"
            title="Projects created"
            description={
              <section aria-label="Created projects">
                <p>
                  These projects remain even if you cancel. No content was
                  copied.
                </p>
                <ul>
                  {draft.createdProjectIds.map((id) => (
                    <li key={id}>{knownRows[id]?.title ?? id}</li>
                  ))}
                </ul>
              </section>
            }
          />
        )}
        {error && <Alert role="alert" type="error" title={error} />}
        <div role="status" className="invitation-status">
          {busy ? "Working..." : searchBusy ? "Searching..." : notice}
        </div>
        {previousOperations.length > 0 && (
          <details>
            <summary>Previous results</summary>
            {previousOperations.map((previous) => (
              <InvitationResults
                key={previous.operation_id}
                operation={previous}
                projects={knownRows}
              />
            ))}
          </details>
        )}
        {step === "person" && (
          <>
            <label htmlFor={inputId}>Email, name, or @username</label>
            <Input.Search
              ref={personInput}
              aria-label="Email, name, or @username"
              id={inputId}
              value={draft.recipientQuery}
              maxLength={254}
              disabled={busy}
              autoComplete="off"
              placeholder="Enter an email, name, or @username"
              enterButton="Find person"
              loading={searchBusy}
              onSearch={() => void searchRecipients()}
              onChange={(event) => {
                request.current++;
                setSearchBusy(false);
                setMatches([]);
                setCandidate(undefined);
                setNotice("");
                edit({ recipientQuery: event.target.value });
              }}
            />
            <details className="invitation-help">
              <summary>Searching by username</summary>
              Use an exact public @username, not a personal alias. Names may
              match more than one person.
            </details>
            <Radio.Group
              aria-label="Matching people"
              value={candidate ? recipientKey(candidate) : undefined}
              className="invitation-people"
              disabled={busy}
              onChange={(event) =>
                setCandidate(
                  recipients.find(
                    (r) => recipientKey(r) === event.target.value,
                  ),
                )
              }
            >
              {recipients.map((recipient) => (
                <div
                  key={recipientKey(recipient)}
                  className="invitation-person"
                >
                  <Radio
                    value={recipientKey(recipient)}
                    aria-label={
                      recipient.kind === "email"
                        ? `Invite ${recipient.email_address}`
                        : `${recipient.label}${recipient.username ? ` (@${recipient.username})` : ""}`
                    }
                  >
                    <span className="invitation-person-label">
                      <Avatar aria-hidden>
                        {recipient.kind === "email"
                          ? "@"
                          : recipient.label.slice(0, 1).toUpperCase()}
                      </Avatar>
                      <span>
                        <strong>
                          {recipient.kind === "email"
                            ? `Invite ${recipient.email_address}`
                            : recipient.label}
                        </strong>
                        <Typography.Text
                          type="secondary"
                          className="invitation-person-subtitle"
                        >
                          {recipient.kind === "email"
                            ? "Send an email invitation"
                            : recipient.username
                              ? `@${recipient.username}`
                              : "CoCalc account"}
                        </Typography.Text>
                      </span>
                    </span>
                  </Radio>
                  {recipient.kind === "account" && (
                    <details className="invitation-help">
                      <summary>Account details</summary>
                      <code>{recipient.account_id}</code>
                    </details>
                  )}
                </div>
              ))}
            </Radio.Group>
          </>
        )}
        {step === "projects" && (
          <>
            <div className="invitation-recipient">
              <Avatar aria-hidden>
                {draft.recipient?.label.slice(0, 1).toUpperCase()}
              </Avatar>
              <span style={{ flex: 1, minWidth: 0 }}>
                Inviting <strong>{draft.recipient?.label}</strong>
              </span>
              <Button
                type="link"
                size="small"
                disabled={busy}
                onClick={() => {
                  setStep("person");
                  setNotice("");
                }}
              >
                Change person
              </Button>
            </div>
            {draft.target && (
              <Alert
                role="note"
                type="info"
                title={`Work together on: ${draft.target.label ?? draft.target.kind}`}
                description={
                  <section aria-label="Content invitation">
                    Content stays in{" "}
                    {knownRows[draft.target.project_id]?.title ??
                      "its source project"}
                    . Inviting to another project does not copy it or grant
                    access to it.
                    <Button
                      type="link"
                      size="small"
                      disabled={busy}
                      onClick={() => edit({ target: undefined })}
                    >
                      Remove content context
                    </Button>
                  </section>
                }
              />
            )}
            <div className="invitation-toolbar">
              <Input.Search
                ref={projectInput}
                id={searchId}
                aria-label="Search projects"
                placeholder="Search projects"
                value={query}
                disabled={busy}
                enterButton="Search"
                onChange={(event) => setQuery(event.target.value)}
                onSearch={() =>
                  draft.recipient &&
                  void loadProjects(draft.recipient, { search: query })
                }
              />
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
                  New project
                </Button>
              )}
            </div>
            <InvitationProjectsTable
              rows={rows}
              knownRows={knownRows}
              choices={draft.projects}
              targetProjectId={draft.target?.project_id}
              disabled={busy}
              onChange={(projects) => edit({ projects })}
            />
            <Space wrap>
              <Button
                type="link"
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
            </Space>
            {onCreateProject && (
              <Typography.Paragraph
                type="secondary"
                className="invitation-help"
              >
                A new project belongs to you. The recipient joins after
                accepting; nothing is copied.
              </Typography.Paragraph>
            )}
          </>
        )}
        {(step === "projects" || step === "review") && targetMissing && (
          <Alert
            role="alert"
            type="warning"
            title="The selected content stays in its source project."
            description="Select that project or remove the content context before reviewing; another project does not grant access to this content."
          />
        )}
        {(step === "projects" || step === "review") && (
          <>
            {step === "review" &&
              (review ? (
                <InvitationReviewDetails
                  review={review}
                  recipientLabel={draft.recipient?.label}
                  projects={knownRows}
                />
              ) : (
                <Typography.Paragraph role="status">
                  Your invitation changed. Review again before sending.
                </Typography.Paragraph>
              ))}
            <label htmlFor={messageId}>Invitation message</label>
            <Input.TextArea
              id={messageId}
              value={draft.message}
              maxLength={PEOPLE_INVITATION_LIMITS.message}
              autoSize={{ minRows: 2, maxRows: 5 }}
              disabled={busy}
              placeholder="Add a personal note..."
              onChange={(event) => edit({ message: event.target.value })}
            />
            <fieldset disabled={busy} className="invitation-channels">
              <legend>Send via</legend>
              <Space wrap>
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
              </Space>
            </fieldset>
            {expired && review && (
              <Alert
                role="alert"
                type="warning"
                title="Please review again before sending."
              />
            )}
          </>
        )}
        {step === "results" && (
          <>
            {operation && (
              <InvitationResults
                operation={operation}
                projects={knownRows}
                recipientLabel={draft.recipient?.label}
              />
            )}
            {(operation || unknownSend) && (
              <Button disabled={busy} onClick={() => void inspect()}>
                Check status
              </Button>
            )}
            {unknownSend && (
              <Alert
                role="note"
                type="warning"
                title="We could not confirm the result."
                description={
                  <>
                    <p>
                      Check status before retrying. Successful actions will not
                      be repeated.
                    </p>
                    <details>
                      <summary>Recovery details</summary>
                      <code>{session.current.sendKey}</code>
                    </details>
                  </>
                }
              />
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
