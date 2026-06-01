/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import { useEffect, useState } from "react";

import type {
  AbuseReviewAnnotation,
  AbuseReviewCategory,
  AbuseReviewDisposition,
  AbuseReviewPriorityAdjustment,
} from "@cocalc/conat/hub/api/purchases";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { Icon } from "@cocalc/frontend/components";
import ShowError from "@cocalc/frontend/components/error";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const { Text } = Typography;

const CATEGORY_OPTIONS: { label: string; value: AbuseReviewCategory }[] = [
  { label: "CPU", value: "cpu" },
  { label: "Egress", value: "egress" },
  { label: "Storage", value: "storage" },
  { label: "Signup", value: "signup" },
  { label: "Payment", value: "payment" },
  { label: "General", value: "general" },
];

const DISPOSITION_OPTIONS: {
  label: string;
  value: AbuseReviewDisposition;
}[] = [
  { label: "Legitimate", value: "legitimate" },
  { label: "Suspicious", value: "suspicious" },
  { label: "Abusive", value: "abusive" },
  { label: "Needs follow-up", value: "needs_followup" },
  { label: "False positive", value: "false_positive" },
];

const PRIORITY_OPTIONS: {
  label: string;
  value: AbuseReviewPriorityAdjustment;
}[] = [
  { label: "Suppress", value: "suppress" },
  { label: "Lower", value: "lower" },
  { label: "Normal", value: "normal" },
  { label: "Raise", value: "raise" },
  { label: "Urgent", value: "urgent" },
];

const EXPIRATION_OPTIONS = [
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "90 days", value: "90d" },
  { label: "1 year", value: "1y" },
  { label: "No expiration", value: "none" },
] as const;

type ExpirationOption = (typeof EXPIRATION_OPTIONS)[number]["value"];

function expirationDate(value: ExpirationOption): string | null {
  if (value === "none") return null;
  const days =
    value === "7d" ? 7 : value === "30d" ? 30 : value === "90d" ? 90 : 365;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function isSensitive({
  disposition,
  priority_adjustment,
}: {
  disposition: AbuseReviewDisposition;
  priority_adjustment: AbuseReviewPriorityAdjustment;
}): boolean {
  return disposition === "abusive" || priority_adjustment === "urgent";
}

export function activeAnnotationPriority(
  annotations?: AbuseReviewAnnotation[],
): AbuseReviewPriorityAdjustment | undefined {
  const priorities: AbuseReviewPriorityAdjustment[] = [
    "urgent",
    "raise",
    "suppress",
    "lower",
    "normal",
  ];
  return priorities.find((priority) =>
    (annotations ?? []).some(
      (annotation) => annotation.priority_adjustment === priority,
    ),
  );
}

export function reviewSortRank(annotations?: AbuseReviewAnnotation[]): number {
  switch (activeAnnotationPriority(annotations)) {
    case "urgent":
      return 0;
    case "raise":
      return 1;
    case "normal":
    case undefined:
      return 2;
    case "lower":
      return 3;
    case "suppress":
      return 4;
  }
}

function annotationTagColor(priority: AbuseReviewPriorityAdjustment): string {
  switch (priority) {
    case "urgent":
      return "red";
    case "raise":
      return "orange";
    case "suppress":
      return "green";
    case "lower":
      return "blue";
    case "normal":
      return "default";
  }
}

function formatAnnotation(annotation: AbuseReviewAnnotation): string {
  return `${annotation.disposition.replace(/_/g, " ")} / ${annotation.priority_adjustment}`;
}

function ActiveAnnotationTags({
  annotations,
}: {
  annotations?: AbuseReviewAnnotation[];
}) {
  if (!annotations || annotations.length === 0) return null;
  return (
    <>
      {annotations.slice(0, 2).map((annotation) => (
        <Tag
          key={annotation.id}
          color={annotationTagColor(annotation.priority_adjustment)}
        >
          {formatAnnotation(annotation)}
        </Tag>
      ))}
    </>
  );
}

export function AbuseAnnotationControls({
  account_id,
  project_id,
  active_annotations,
  defaultCategory = "cpu",
  evidence,
  onChange,
}: {
  account_id: string;
  project_id?: string | null;
  active_annotations?: AbuseReviewAnnotation[];
  defaultCategory?: AbuseReviewCategory;
  evidence?: Record<string, unknown>;
  onChange?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<AbuseReviewAnnotation[]>([]);
  const [category, setCategory] =
    useState<AbuseReviewCategory>(defaultCategory);
  const [disposition, setDisposition] =
    useState<AbuseReviewDisposition>("legitimate");
  const [priorityAdjustment, setPriorityAdjustment] =
    useState<AbuseReviewPriorityAdjustment>("lower");
  const [expiration, setExpiration] = useState<ExpirationOption>("90d");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<any>(null);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => setError(err),
  });

  async function loadHistory() {
    setLoading(true);
    setError(null);
    try {
      const annotations =
        await webapp_client.conat_client.hub.purchases.listAbuseReviewAnnotations(
          {
            user_account_id: account_id,
            project_id: project_id ?? undefined,
            limit: 50,
          },
        );
      setHistory(annotations as AbuseReviewAnnotation[]);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) {
      void loadHistory();
    }
  }, [open, account_id, project_id]);

  async function createAnnotation() {
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setError("A reason is required.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const action = async () => {
        await webapp_client.conat_client.hub.purchases.createAbuseReviewAnnotation(
          {
            browser_id: webapp_client.browser_id,
            user_account_id: account_id,
            project_id: project_id ?? undefined,
            category,
            disposition,
            priority_adjustment: priorityAdjustment,
            reason: trimmedReason,
            evidence: evidence ?? null,
            expires_at: expirationDate(expiration),
          },
        );
      };
      if (
        isSensitive({
          disposition,
          priority_adjustment: priorityAdjustment,
        })
      ) {
        await runFreshAuthAction(action);
      } else {
        await action();
      }
      setReason("");
      void message.success("Abuse review annotation saved.");
      await loadHistory();
      onChange?.();
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  async function revoke(annotation: AbuseReviewAnnotation) {
    const revokedReason = window.prompt("Reason for revoking this annotation:");
    if (!revokedReason?.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await runFreshAuthAction(async () => {
        await webapp_client.conat_client.hub.purchases.revokeAbuseReviewAnnotation(
          {
            browser_id: webapp_client.browser_id,
            id: annotation.id,
            revoked_reason: revokedReason.trim(),
          },
        );
      });
      void message.success("Abuse review annotation revoked.");
      await loadHistory();
      onChange?.();
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Space wrap>
        <ActiveAnnotationTags annotations={active_annotations} />
        <Button size="small" onClick={() => setOpen(true)}>
          <Icon name="tags-outlined" /> Annotate
        </Button>
      </Space>
      <Modal
        open={open}
        title="Abuse review annotations"
        onCancel={() => setOpen(false)}
        onOk={() => void createAnnotation()}
        okText="Save annotation"
        okButtonProps={{ disabled: !reason.trim(), loading }}
        width={760}
      >
        <ShowError error={error} setError={setError} />
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Alert
            showIcon
            type="info"
            message="Annotations affect admin review priority only. Raw usage remains visible and user-facing limits are unchanged."
          />
          <Space wrap>
            <Select
              value={category}
              options={CATEGORY_OPTIONS}
              style={{ width: 130 }}
              onChange={setCategory}
            />
            <Select
              value={disposition}
              options={DISPOSITION_OPTIONS}
              style={{ width: 170 }}
              onChange={setDisposition}
            />
            <Select
              value={priorityAdjustment}
              options={PRIORITY_OPTIONS}
              style={{ width: 140 }}
              onChange={setPriorityAdjustment}
            />
            <Select
              value={expiration}
              options={[...EXPIRATION_OPTIONS]}
              style={{ width: 150 }}
              onChange={setExpiration}
            />
          </Space>
          <Input.TextArea
            value={reason}
            maxLength={4000}
            showCount
            placeholder="Reason, e.g. inspected project: legitimate number theory computation."
            autoSize={{ minRows: 3, maxRows: 6 }}
            onChange={(event) => setReason(event.target.value)}
          />
          <div>
            <Text strong>History</Text>
            <Space
              direction="vertical"
              size={8}
              style={{ marginTop: 8, width: "100%" }}
            >
              {history.length === 0 ? (
                <Text type="secondary">
                  {loading ? "Loading..." : "No annotations yet."}
                </Text>
              ) : (
                history.map((annotation) => (
                  <div key={annotation.id}>
                    <Space wrap>
                      <Tag color={annotation.revoked_at ? "default" : "blue"}>
                        {annotation.category}
                      </Tag>
                      <Tag
                        color={annotationTagColor(
                          annotation.priority_adjustment,
                        )}
                      >
                        {formatAnnotation(annotation)}
                      </Tag>
                      {annotation.expires_at ? (
                        <Text type="secondary">
                          expires{" "}
                          {new Date(annotation.expires_at).toLocaleString()}
                        </Text>
                      ) : (
                        <Text type="secondary">no expiration</Text>
                      )}
                      {annotation.revoked_at ? (
                        <Text type="secondary">revoked</Text>
                      ) : (
                        <Button
                          size="small"
                          disabled={loading}
                          onClick={() => void revoke(annotation)}
                        >
                          Revoke
                        </Button>
                      )}
                    </Space>
                    <div style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>
                      {annotation.reason}
                    </div>
                  </div>
                ))
              )}
            </Space>
          </div>
        </Space>
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}
