/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";

import api from "@cocalc/frontend/client/api";
import { PublicSectionCard } from "@cocalc/frontend/public/ui/shell";
import { COLORS } from "@cocalc/util/theme";

type SupportView = "index" | "new" | "tickets";
type TicketType = "problem" | "question" | "task" | "purchase" | "chat";

interface SupportConfig {
  support_video_call?: string;
  zendesk?: boolean;
}

const STACK_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
} as const;

const FIELD_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
} as const;

const INPUT_STYLE: CSSProperties = {
  width: "100%",
  borderRadius: "8px",
  border: `1px solid ${COLORS.GRAY_LL}`,
  padding: "10px 12px",
  fontSize: "16px",
  fontFamily: "inherit",
} as const;

const BUTTON_STYLE: CSSProperties = {
  border: "none",
  borderRadius: "8px",
  background: COLORS.BLUE_D,
  color: "white",
  fontSize: "16px",
  fontWeight: 600,
  padding: "11px 16px",
  cursor: "pointer",
} as const;

const SUBTLE_BUTTON_STYLE: CSSProperties = {
  ...BUTTON_STYLE,
  background: COLORS.GRAY_LL,
  color: COLORS.GRAY_D,
} as const;

const ALERT_BASE_STYLE: CSSProperties = {
  borderRadius: "8px",
  padding: "10px 12px",
  fontSize: "14px",
} as const;

const LINK_STYLE: CSSProperties = {
  color: COLORS.BLUE_D,
  cursor: "pointer",
} as const;

function Alert({
  children,
  kind,
}: {
  children: ReactNode;
  kind: "error" | "success";
}) {
  const style: CSSProperties =
    kind === "error"
      ? {
          ...ALERT_BASE_STYLE,
          background: "#fff2f0",
          border: "1px solid #ffccc7",
          color: "#a8071a",
        }
      : {
          ...ALERT_BASE_STYLE,
          background: "#f6ffed",
          border: "1px solid #b7eb8f",
          color: "#237804",
        };
  return <div style={style}>{children}</div>;
}

function TicketTypeOptions({
  value,
  onChange,
}: {
  onChange: (value: TicketType) => void;
  value: TicketType;
}) {
  const options: Array<{ value: TicketType; label: string }> = [
    { value: "problem", label: "Problem" },
    { value: "question", label: "Question" },
    { value: "task", label: "Software install task" },
    { value: "purchase", label: "Purchase question" },
    { value: "chat", label: "Video chat" },
  ];
  return (
    <div style={{ display: "grid", gap: "8px" }}>
      {options.map((option) => (
        <label
          key={option.value}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            border: `1px solid ${COLORS.GRAY_LL}`,
            borderRadius: "8px",
            padding: "10px 12px",
          }}
        >
          <input
            checked={value === option.value}
            name="support-type"
            type="radio"
            value={option.value}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

export default function SupportNew({
  config,
  onNavigate,
}: {
  config: SupportConfig;
  onNavigate: (view: SupportView) => void;
}) {
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [type, setType] = useState<TicketType>("problem");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [successUrl, setSuccessUrl] = useState("");

  if (!config.zendesk) {
    return (
      <Alert kind="error">Support ticket creation is not configured.</Alert>
    );
  }

  const canSubmit =
    !submitting &&
    email.trim().length > 3 &&
    subject.trim().length > 3 &&
    body.trim().length >= 16;

  async function submit() {
    if (!canSubmit) {
      return;
    }
    setSubmitting(true);
    setError("");
    setSuccessUrl("");
    try {
      const result = await api("support/create-ticket", {
        options: {
          email,
          subject,
          body,
          type,
          url: window.location.href,
          info: {
            context: "public-support",
            userAgent: navigator.userAgent,
          },
        },
      });
      if (result?.url) {
        setSuccessUrl(result.url);
      } else if (result?.error) {
        setError(result.error);
      }
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={STACK_STYLE}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <div style={{ color: COLORS.GRAY }}>
          Need general help first?{" "}
          <a
            style={LINK_STYLE}
            onClick={(e) => {
              e.preventDefault();
              onNavigate("index");
            }}
          >
            Back to support options
          </a>
        </div>
        {config.support_video_call ? (
          <a href={config.support_video_call} style={LINK_STYLE}>
            Book a video chat
          </a>
        ) : null}
      </div>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {successUrl ? (
        <Alert kind="success">
          Ticket created. Save this URL:{" "}
          <a href={successUrl} style={LINK_STYLE}>
            {successUrl}
          </a>
        </Alert>
      ) : null}
      <PublicSectionCard>
        <div style={STACK_STYLE}>
          <div style={FIELD_STYLE}>
            <div>Email address</div>
            <input
              style={INPUT_STYLE}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
            />
          </div>
          <div style={FIELD_STYLE}>
            <div>Subject</div>
            <input
              style={INPUT_STYLE}
              value={subject}
              onChange={(e) => setSubject(e.currentTarget.value)}
            />
          </div>
          <div style={FIELD_STYLE}>
            <div>Support request type</div>
            <TicketTypeOptions value={type} onChange={setType} />
          </div>
          <div style={FIELD_STYLE}>
            <div>Description</div>
            <textarea
              rows={10}
              style={{ ...INPUT_STYLE, resize: "vertical" }}
              value={body}
              onChange={(e) => setBody(e.currentTarget.value)}
            />
          </div>
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <button disabled={!canSubmit} style={BUTTON_STYLE} onClick={submit}>
              {submitting ? "Submitting..." : "Create support ticket"}
            </button>
            <button
              style={SUBTLE_BUTTON_STYLE}
              onClick={() => onNavigate("tickets")}
            >
              View my tickets
            </button>
          </div>
        </div>
      </PublicSectionCard>
    </div>
  );
}
