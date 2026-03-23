/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import api from "@cocalc/frontend/client/api";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";
import { COLORS, HELP_EMAIL, SITE_NAME } from "@cocalc/util/theme";

type SupportView = "index" | "new" | "tickets";
type TicketType = "problem" | "question" | "task" | "purchase" | "chat";

interface SupportTicket {
  created_at?: string;
  description?: string;
  id?: number | string;
  status?: string;
  subject?: string;
  type?: TicketType;
  updated_at?: string;
  userURL?: string;
}

interface SupportConfig {
  help_email?: string;
  on_cocalc_com?: boolean;
  site_name?: string;
  support?: string;
  support_video_call?: string;
  zendesk?: boolean;
}

interface PublicSupportAppProps {
  config?: SupportConfig;
  initialView: SupportView;
}

const PAGE_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "center",
  minHeight: "100%",
  padding: "40px 16px",
  background: COLORS.GRAY_LLL,
} as const;

const CARD_STYLE: CSSProperties = {
  width: "min(860px, 100%)",
  borderRadius: "12px",
  border: `1px solid ${COLORS.GRAY_LL}`,
  boxShadow: "0 12px 32px rgba(0, 0, 0, 0.08)",
  background: "white",
  padding: "32px",
  color: COLORS.GRAY_D,
} as const;

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

function supportPath(view: SupportView): string {
  const base = appBasePath === "/" ? "" : appBasePath;
  switch (view) {
    case "new":
      return `${base}/support/new`;
    case "tickets":
      return `${base}/support/tickets`;
    default:
      return `${base}/support`;
  }
}

export function getSupportViewFromPath(pathname: string): SupportView {
  if (pathname.includes("/support/new")) {
    return "new";
  }
  if (pathname.includes("/support/tickets")) {
    return "tickets";
  }
  return "index";
}

function titleForView(view: SupportView, siteName: string): string {
  switch (view) {
    case "new":
      return `Create a ${siteName} support ticket`;
    case "tickets":
      return `${siteName} support tickets`;
    default:
      return `${siteName} support`;
  }
}

function Alert({
  children,
  kind,
}: {
  children: ReactNode;
  kind: "error" | "info" | "success";
}) {
  const style: CSSProperties =
    kind === "error"
      ? {
          ...ALERT_BASE_STYLE,
          background: "#fff2f0",
          border: "1px solid #ffccc7",
          color: "#a8071a",
        }
      : kind === "success"
        ? {
            ...ALERT_BASE_STYLE,
            background: "#f6ffed",
            border: "1px solid #b7eb8f",
            color: "#237804",
          }
        : {
            ...ALERT_BASE_STYLE,
            background: "#e6f4ff",
            border: "1px solid #91caff",
            color: "#0958d9",
          };
  return <div style={style}>{children}</div>;
}

function NavLink({
  children,
  href,
  onClick,
}: {
  children: ReactNode;
  href?: string;
  onClick?: () => void;
}) {
  if (href) {
    return (
      <a href={href} style={LINK_STYLE}>
        {children}
      </a>
    );
  }
  return (
    <a
      style={LINK_STYLE}
      onClick={(e) => {
        e.preventDefault();
        onClick?.();
      }}
    >
      {children}
    </a>
  );
}

function StatusPill({ status }: { status?: string }) {
  const label = `${status ?? "open"}`.toUpperCase();
  const color =
    status === "solved"
      ? COLORS.GRAY_M
      : status === "pending"
        ? "#f5ca00"
        : COLORS.BLUE_D;
  return (
    <span
      style={{
        display: "inline-block",
        borderRadius: "999px",
        background: color,
        color: "white",
        fontSize: "12px",
        fontWeight: 700,
        padding: "4px 8px",
      }}
    >
      {label}
    </span>
  );
}

function TypePill({ type }: { type?: TicketType }) {
  return (
    <span
      style={{
        display: "inline-block",
        borderRadius: "999px",
        border: `1px solid ${COLORS.GRAY_LL}`,
        color: COLORS.GRAY_D,
        fontSize: "12px",
        padding: "4px 8px",
        textTransform: "capitalize",
      }}
    >
      {type ?? "support"}
    </span>
  );
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

function formatDate(value?: string): string {
  if (!value) {
    return "";
  }
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function SupportIndex({
  config,
  onNavigate,
}: {
  config: SupportConfig;
  onNavigate: (view: SupportView) => void;
}) {
  const helpEmail = config.help_email ?? HELP_EMAIL;
  const hasZendesk = !!config.zendesk;

  if (!config.on_cocalc_com && config.support) {
    return (
      <div style={STACK_STYLE}>
        <Alert kind="info">{config.support}</Alert>
        <div>
          Need more help?{" "}
          <a href={`mailto:${helpEmail}`} style={LINK_STYLE}>
            Contact {helpEmail}
          </a>
          .
        </div>
      </div>
    );
  }

  return (
    <div style={STACK_STYLE}>
      <p style={{ fontSize: "16px", margin: 0 }}>
        We provide direct support, documentation, and community channels. Use
        the links below to open a ticket, review ticket status, or contact us.
      </p>
      <div
        style={{
          display: "grid",
          gap: "16px",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        }}
      >
        {hasZendesk ? (
          <SupportCard
            description="Create a new support ticket."
            title="New support ticket"
          >
            <button style={BUTTON_STYLE} onClick={() => onNavigate("new")}>
              Open ticket form
            </button>
          </SupportCard>
        ) : null}
        {hasZendesk ? (
          <SupportCard
            description="Check the status of your recent support tickets."
            title="Ticket status"
          >
            <button
              style={SUBTLE_BUTTON_STYLE}
              onClick={() => onNavigate("tickets")}
            >
              View tickets
            </button>
          </SupportCard>
        ) : null}
        {config.support_video_call ? (
          <SupportCard
            description="Book a video call with the CoCalc team."
            title="Video chat"
          >
            <a href={config.support_video_call} style={LINK_STYLE}>
              Book a call
            </a>
          </SupportCard>
        ) : null}
        <SupportCard
          description="Browse user and admin documentation."
          title="Documentation"
        >
          <a href="https://doc.cocalc.com/" style={LINK_STYLE}>
            Read the docs
          </a>
        </SupportCard>
        <SupportCard
          description="Reach the team directly by email."
          title="Email"
        >
          <a href={`mailto:${helpEmail}`} style={LINK_STYLE}>
            {helpEmail}
          </a>
        </SupportCard>
      </div>
    </div>
  );
}

function SupportCard({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div
      style={{
        border: `1px solid ${COLORS.GRAY_LL}`,
        borderRadius: "12px",
        padding: "18px",
      }}
    >
      <div style={{ fontWeight: 700, fontSize: "18px", marginBottom: "8px" }}>
        {title}
      </div>
      <div style={{ color: COLORS.GRAY, marginBottom: "16px" }}>
        {description}
      </div>
      <div>{children}</div>
    </div>
  );
}

function SupportNew({
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
        }}
      >
        <div style={{ color: COLORS.GRAY }}>
          Need general help first?{" "}
          <NavLink onClick={() => onNavigate("index")}>
            Back to support options
          </NavLink>
        </div>
        {config.support_video_call ? (
          <a href={config.support_video_call} style={LINK_STYLE}>
            Book a video chat
          </a>
        ) : null}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {successUrl && (
        <Alert kind="success">
          Ticket created. Save this URL:{" "}
          <a href={successUrl} style={LINK_STYLE}>
            {successUrl}
          </a>
        </Alert>
      )}
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
  );
}

function SupportTickets({ config }: { config: SupportConfig }) {
  const [tickets, setTickets] = useState<SupportTicket[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let canceled = false;
    (async () => {
      try {
        const result = await api("support/tickets");
        if (canceled) {
          return;
        }
        if (result?.error) {
          setError(result.error);
          return;
        }
        setTickets(result?.tickets ?? []);
      } catch (err) {
        if (!canceled) {
          setError(`${err}`);
        }
      }
    })();
    return () => {
      canceled = true;
    };
  }, []);

  if (!config.zendesk) {
    return <Alert kind="error">Support tickets are not configured.</Alert>;
  }

  if (error) {
    const signInTarget = `${joinUrlPath(appBasePath, "auth/sign-in")}?target=${encodeURIComponent(window.location.pathname)}`;
    return (
      <Alert kind="error">
        {error}
        {error.includes("must be signed in") ? (
          <>
            {" "}
            <a href={signInTarget} style={LINK_STYLE}>
              Sign in
            </a>{" "}
            to see your tickets.
          </>
        ) : null}
      </Alert>
    );
  }

  if (tickets == null) {
    return <Alert kind="info">Loading support tickets...</Alert>;
  }

  if (tickets.length === 0) {
    return <Alert kind="info">No support tickets found yet.</Alert>;
  }

  return (
    <div style={STACK_STYLE}>
      {tickets.map((ticket, i) => (
        <div
          key={`${ticket.id ?? i}`}
          style={{
            border: `1px solid ${COLORS.GRAY_LL}`,
            borderRadius: "12px",
            padding: "18px",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "10px",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: "18px" }}>
              {ticket.subject ?? `Ticket ${ticket.id ?? i + 1}`}
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <StatusPill status={ticket.status} />
              <TypePill type={ticket.type} />
            </div>
          </div>
          <div
            style={{ color: COLORS.GRAY, marginTop: "8px", fontSize: "14px" }}
          >
            Created {formatDate(ticket.created_at)}; updated{" "}
            {formatDate(ticket.updated_at)}
          </div>
          <div
            style={{
              marginTop: "12px",
              whiteSpace: "pre-wrap",
              background: COLORS.GRAY_LLL,
              borderRadius: "8px",
              padding: "12px",
            }}
          >
            {ticket.description ?? ""}
          </div>
          {ticket.userURL ? (
            <div style={{ marginTop: "12px" }}>
              <a href={ticket.userURL} style={LINK_STYLE}>
                Open full ticket details
              </a>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export default function PublicSupportApp({
  config = {},
  initialView,
}: PublicSupportAppProps) {
  const [view, setView] = useState(initialView);
  const title = useMemo(
    () => titleForView(view, config.site_name ?? SITE_NAME),
    [config.site_name, view],
  );

  useEffect(() => {
    document.title = title;
  }, [title]);

  function navigate(next: SupportView) {
    setView(next);
    window.history.pushState({}, "", supportPath(next));
  }

  return (
    <div style={PAGE_STYLE}>
      <div style={CARD_STYLE}>
        <div style={{ marginBottom: "24px" }}>
          <div
            style={{
              color: COLORS.GRAY,
              fontSize: "14px",
              fontWeight: 700,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            Support
          </div>
          <h1
            style={{
              margin: "8px 0 0 0",
              color: COLORS.GRAY_D,
              fontSize: "32px",
              lineHeight: 1.2,
            }}
          >
            {title}
          </h1>
        </div>
        {view === "index" && (
          <SupportIndex config={config} onNavigate={navigate} />
        )}
        {view === "new" && <SupportNew config={config} onNavigate={navigate} />}
        {view === "tickets" && <SupportTickets config={config} />}
      </div>
    </div>
  );
}
