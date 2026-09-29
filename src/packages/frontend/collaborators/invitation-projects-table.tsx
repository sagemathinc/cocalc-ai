/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { Button, Checkbox, Input, Select, Tag, Typography } from "antd";
import { useState } from "react";
import { DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY } from "@cocalc/util/project-access";
import type { ProjectViewerReadPolicy } from "@cocalc/util/project-access";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type {
  InvitationProject,
  InvitationProjectChoice,
} from "./invitation-api";
import {
  defaultProjectChoice,
  invitationChoiceLabel,
  INVITATION_PROJECT_LIMIT,
  projectAccessLabel,
} from "./invitation-choices";
import {
  selectedTextFromViewerPolicy,
  selectedViewerPolicyFromText,
} from "./viewer-read-policy";

export function InvitationPolicyDetails({
  policy,
}: {
  policy?: ProjectViewerReadPolicy;
}) {
  if (!policy)
    return (
      <p>
        Read policy is not available; access must be checked before opening
        content.
      </p>
    );
  return (
    <ul aria-label="Exact read policy">
      {policy.rules.map((rule, index) => (
        <li key={index}>
          {rule.action}: <code>{rule.path || "."}</code>
        </li>
      ))}
    </ul>
  );
}

function InvitationPolicyEditor({
  title,
  policy,
  onChange,
}: {
  title: string;
  policy: ProjectViewerReadPolicy;
  onChange: (policy: ProjectViewerReadPolicy) => void;
}) {
  const [text, setText] = useState(
    () =>
      selectedTextFromViewerPolicy(policy) ||
      (policy.rules.some((rule) => rule.action === "include") ? "." : ""),
  );
  return (
    <label style={{ display: "block", marginTop: 8 }}>
      Viewer file access for {title}
      <Input.TextArea
        aria-label={`Viewer file access for ${title}`}
        maxLength={10000}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onChange(selectedViewerPolicyFromText(event.target.value));
        }}
      />
    </label>
  );
}

export function InvitationProjectsTable({
  rows,
  knownRows,
  choices,
  disabled,
  targetProjectId,
  onChange,
}: {
  rows: InvitationProject[];
  knownRows: Record<string, InvitationProject>;
  choices: InvitationProjectChoice[];
  disabled: boolean;
  targetProjectId?: string;
  onChange: (choices: InvitationProjectChoice[]) => void;
}) {
  const atLimit = choices.length >= INVITATION_PROJECT_LIMIT;
  const shared = (row: InvitationProject) =>
    ["owner", "collaborator", "viewer"].includes(row.current_access);
  const sortedRows = [
    ...rows.filter(shared),
    ...rows.filter((row) => !shared(row)),
  ];
  function replace(choice: InvitationProjectChoice) {
    const existing = choices.some(
      (item) => item.project_id === choice.project_id,
    );
    if (disabled || (!existing && atLimit)) return;
    onChange(
      existing
        ? choices.map((item) =>
            item.project_id === choice.project_id ? choice : item,
          )
        : [...choices, choice],
    );
  }
  return (
    <>
      <div
        className="invitation-project-scroll"
        role="region"
        aria-label="Project choices"
        tabIndex={0}
      >
        <table
          className="invitation-project-table"
          aria-label="Projects and this person's current access"
          style={{
            width: "100%",
            borderCollapse: "collapse",
            color: UI_COLORS.text,
            background: UI_COLORS.surface,
          }}
        >
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Current access</th>
              <th scope="col">Invitation</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.flatMap((row, index) => {
              const choice = choices.find(
                (item) => item.project_id === row.project_id,
              );
              const initial = defaultProjectChoice(row);
              const existing =
                row.current_access === "owner" ||
                row.current_access === "collaborator";
              return [
                ...(index === 0 || shared(row) !== shared(sortedRows[index - 1])
                  ? [
                      <tr
                        key={shared(row) ? "shared-heading" : "other-heading"}
                      >
                        <th colSpan={3} scope="colgroup">
                          <Typography.Text type="secondary">
                            {shared(row) ? "Already shared" : "Other projects"}
                          </Typography.Text>
                        </th>
                      </tr>,
                    ]
                  : []),
                <tr
                  key={row.project_id}
                  style={{ borderTop: `1px solid ${UI_COLORS.border}` }}
                >
                  <th
                    scope="row"
                    style={{
                      verticalAlign: "top",
                      padding: 8,
                      overflowWrap: "anywhere",
                    }}
                  >
                    <Checkbox
                      aria-label={`Select ${row.title}`}
                      checked={!!choice}
                      disabled={disabled || (!choice && (atLimit || !initial))}
                      onChange={(event) =>
                        event.target.checked
                          ? initial && replace(initial)
                          : onChange(
                              choices.filter(
                                (item) => item.project_id !== row.project_id,
                              ),
                            )
                      }
                    >
                      {row.title}
                    </Checkbox>
                  </th>
                  <td
                    data-label="Current access"
                    style={{ verticalAlign: "top", padding: 8 }}
                  >
                    <Tag>{projectAccessLabel(row)}</Tag>
                    {row.current_access === "viewer" && (
                      <details>
                        <summary>File access</summary>
                        <InvitationPolicyDetails policy={row.read_policy} />
                      </details>
                    )}
                    {row.pending && (
                      <div>
                        Invitation pending: {row.pending.role}
                        {row.pending.role === "viewer" && (
                          <InvitationPolicyDetails
                            policy={row.pending.read_policy}
                          />
                        )}
                      </div>
                    )}
                    {targetProjectId === row.project_id &&
                      row.content_access !== "allowed" && (
                        <p>
                          {row.content_access === "denied"
                            ? "Current access does not allow opening the intended content."
                            : "Content access has not been established."}
                        </p>
                      )}
                    {row.unavailable_reason && <p>{row.unavailable_reason}</p>}
                  </td>
                  <td
                    data-label="Invitation"
                    style={{ verticalAlign: "top", padding: 8 }}
                  >
                    {existing ? (
                      "Notify only"
                    ) : row.current_access === "viewer" ? (
                      <>
                        <span>
                          {choice?.action === "offer_access"
                            ? "Offer collaborator access"
                            : "Notify only; keep viewer access"}
                        </span>
                        {row.can_invite && (
                          <Button
                            size="small"
                            type="link"
                            disabled={disabled || (!choice && atLimit)}
                            onClick={() =>
                              replace({
                                project_id: row.project_id,
                                action: "offer_access",
                                role: "collaborator",
                              })
                            }
                          >
                            Offer collaborator access to {row.title}
                          </Button>
                        )}
                      </>
                    ) : row.can_invite ? (
                      row.pending ? (
                        "Reuse pending invitation"
                      ) : (
                        "Offer access"
                      )
                    ) : (
                      "Unavailable"
                    )}
                  </td>
                </tr>,
              ];
            })}
          </tbody>
        </table>
      </div>
      {!rows.length && <p>No matching projects in this page.</p>}
      <Typography.Paragraph type="secondary" className="invitation-help">
        New access requires acceptance. Selections stay selected when searching
        or changing pages.
      </Typography.Paragraph>
      <section aria-label="Selected project actions">
        {choices.map((choice) => {
          const row = knownRows[choice.project_id];
          const title = row?.title ?? choice.project_id;
          return (
            <fieldset
              key={choice.project_id}
              disabled={disabled}
              className="invitation-selection"
            >
              <legend style={{ overflowWrap: "anywhere" }}>{title}</legend>
              <p>{invitationChoiceLabel(choice)}</p>
              {choice.action === "offer_access" &&
                row?.can_invite &&
                row.current_access !== "collaborator" &&
                row.current_access !== "owner" && (
                  <>
                    <Select
                      aria-label={`Offered role for ${title}`}
                      value={choice.role}
                      style={{ width: "100%" }}
                      onChange={(role: "collaborator" | "viewer") =>
                        replace({
                          project_id: choice.project_id,
                          action: "offer_access",
                          role,
                          ...(role === "viewer"
                            ? {
                                read_policy:
                                  DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY,
                              }
                            : {}),
                        })
                      }
                      options={[
                        {
                          value: "collaborator",
                          label:
                            "Collaborator: project read/write and runtimes",
                        },
                        {
                          value: "viewer",
                          label: "Viewer: read-only files, no runtimes",
                        },
                      ]}
                    />
                    {choice.role === "viewer" && (
                      <>
                        <InvitationPolicyEditor
                          title={title}
                          policy={
                            choice.read_policy ??
                            DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY
                          }
                          onChange={(read_policy) =>
                            replace({ ...choice, read_policy })
                          }
                        />
                        <p>
                          One project-relative path per line. Use . for the full
                          project; sensitive default paths stay excluded.
                        </p>
                        <InvitationPolicyDetails
                          policy={
                            choice.read_policy ??
                            DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY
                          }
                        />
                      </>
                    )}
                  </>
                )}
              {choice.action === "offer_access" &&
                row?.current_access === "viewer" &&
                row.can_notify && (
                  <Button
                    onClick={() =>
                      replace({
                        project_id: choice.project_id,
                        action: "notify",
                      })
                    }
                  >
                    Keep current viewer access for {title}
                  </Button>
                )}
              <Button
                onClick={() =>
                  onChange(
                    choices.filter(
                      (item) => item.project_id !== choice.project_id,
                    ),
                  )
                }
              >
                Remove {title}
              </Button>
            </fieldset>
          );
        })}
      </section>
    </>
  );
}
