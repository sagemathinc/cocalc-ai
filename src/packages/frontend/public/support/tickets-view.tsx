/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";

import api from "@cocalc/frontend/client/api";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { PublicSectionCard } from "@cocalc/frontend/public/ui/shell";
import { joinUrlPath } from "@cocalc/util/url-path";
import { COLORS } from "@cocalc/util/theme";

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
  zendesk?: boolean;
}

const STACK_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
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
  kind: "error" | "info";
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
          background: "#e6f4ff",
          border: "1px solid #91caff",
          color: "#0958d9",
        };
  return <div style={style}>{children}</div>;
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

export default function SupportTickets({ config }: { config: SupportConfig }) {
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
        <PublicSectionCard key={`${ticket.id ?? i}`}>
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
          <div style={{ color: COLORS.GRAY, fontSize: "14px" }}>
            Created {formatDate(ticket.created_at)}; updated{" "}
            {formatDate(ticket.updated_at)}
          </div>
          <div
            style={{
              whiteSpace: "pre-wrap",
              background: COLORS.GRAY_LLL,
              borderRadius: "8px",
              padding: "12px",
            }}
          >
            {ticket.description ?? ""}
          </div>
          {ticket.userURL ? (
            <div>
              <a href={ticket.userURL} style={LINK_STYLE}>
                Open full ticket details
              </a>
            </div>
          ) : null}
        </PublicSectionCard>
      ))}
    </div>
  );
}
