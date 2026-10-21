/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A calendar (.cal.json, the cocalc-calendar format) published as a file
artifact, shown as an agenda: what is overdue first, then the coming days.
Each item opens to its details. The whole calendar downloads as an .ics file
for Google, Apple or Outlook calendars. It reads the current saved file; an
agent keeps the file up to date and the card follows on Refresh.
*/

import { Alert, Button, Space, Tag } from "antd";
import { useEffect, useMemo, useState } from "react";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  calendarAgenda,
  calendarLinkAllowed,
  calendarTimeKind,
  calendarToIcs,
  parseCalendar,
  type CalendarOccurrence,
  type CocalcCalendar,
} from "@cocalc/util/calendar/cocalc-calendar";
import type { FileArtifactAction } from "./file-artifact";

const PREVIEW_LIMIT = 1024 * 1024;

/** Black or white text, whichever reads better on a #rrggbb background
 * (WCAG relative luminance). */
export function readableOn(hex: string): string {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  // Contrast with black (l + 0.05) / 0.05 against white 1.05 / (l + 0.05).
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? "#000000" : "#ffffff";
}

export default function CalendarArtifact({
  path,
  historical,
  onToolbarActions,
  now: nowOverride,
}: {
  path: string;
  historical: boolean;
  onToolbarActions?: (actions: FileArtifactAction[]) => void;
  /** For tests: the time the agenda is shown at. */
  now?: number;
}) {
  const { actions } = useProjectContext();
  const [text, setText] = useState<string>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError("");
    setLoading(true);
    void (async () => {
      try {
        const fs = actions?.fs();
        if (!fs) throw Error("Project filesystem unavailable");
        const stat = await fs.stat(path);
        if (stat.size > PREVIEW_LIMIT)
          throw Error(
            "Calendar exceeds the 1 MiB preview limit. Open the file to read it.",
          );
        const raw = await fs.readFile(path, "utf8");
        if (!cancelled) setText(typeof raw === "string" ? raw : `${raw}`);
      } catch (err) {
        if (!cancelled) {
          // Never show (or export) a calendar the file no longer has.
          setText(undefined);
          setError(`${err}`);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actions, path, refresh]);
  const parsed = useMemo(
    () => (text == null ? undefined : parseCalendar(text)),
    [text],
  );
  const calendar = parsed?.calendar;
  const openInProject = () =>
    void actions?.open_file({ path }).catch((err) => setError(`${err}`));
  const downloadIcs = () => {
    if (!calendar) return;
    const url = URL.createObjectURL(
      new Blob([calendarToIcs(calendar)], { type: "text/calendar" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(path.split("/").pop() ?? "calendar").replace(/\.cal\.json$/i, "")}.ics`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const tools: FileArtifactAction[] = [
    {
      key: "open",
      label: "Open in project",
      icon: "external-link",
      disabled: !actions,
      primary: true,
      onClick: openInProject,
    },
    {
      key: "ics",
      label: "Download .ics",
      icon: "calendar",
      disabled: !calendar,
      onClick: downloadIcs,
    },
    {
      key: "refresh",
      label: "Refresh",
      icon: "refresh",
      disabled: loading,
      onClick: () => setRefresh((n) => n + 1),
    },
  ];
  useEffect(() => {
    onToolbarActions?.(tools);
  }, [onToolbarActions, actions, calendar, loading, path]);
  return (
    <div
      className="smc-vfill"
      style={{
        minHeight: 0,
        padding: 12,
        overflow: "auto",
        color: UI_COLORS.text,
        background: UI_COLORS.surface,
      }}
    >
      {onToolbarActions === undefined && (
        <Space wrap style={{ marginBottom: 8 }}>
          {tools.map((tool) => (
            <Button
              key={tool.key}
              disabled={tool.disabled}
              onClick={tool.onClick}
            >
              {tool.label}
            </Button>
          ))}
        </Space>
      )}
      {/* Announced in the full-size page too, whose header has the tools. */}
      <div role="status">
        {loading ? "Loading current saved calendar..." : ""}
      </div>
      {historical && (
        <div role="note">
          Published file reference; the calendar shown is current, not a
          historical snapshot.
        </div>
      )}
      {error && <Alert type="warning" title={error} />}
      {parsed && parsed.problems.length > 0 && (
        <Alert
          type={calendar ? "info" : "error"}
          title={
            calendar
              ? "Some of this calendar could not be read; the rest is shown."
              : "This is not a calendar CoCalc can show."
          }
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {parsed.problems.slice(0, 10).map((p, i) => (
                <li key={i}>
                  {p.path ? <code>{p.path}</code> : null} {p.message}
                </li>
              ))}
            </ul>
          }
          style={{ marginBottom: 8 }}
        />
      )}
      {calendar && <Agenda calendar={calendar} now={nowOverride} />}
    </div>
  );
}

function Agenda({
  calendar,
  now: nowOverride,
}: {
  calendar: CocalcCalendar;
  now?: number;
}) {
  // The clock moves on while the card is open: items become overdue and past
  // ones leave, once a minute.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (nowOverride != null) return;
    const timer = setInterval(() => setClock(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [nowOverride]);
  const now = nowOverride ?? clock;
  const agenda = useMemo(() => calendarAgenda(calendar, now), [calendar, now]);
  const dayLabel = (date: string) =>
    new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${date}T12:00:00Z`));
  return (
    <div>
      <h3 style={{ margin: "0 0 4px" }}>{calendar.title}</h3>
      {calendar.description && <StaticMarkdown value={calendar.description} />}
      <div style={{ color: UI_COLORS.secondary, marginBottom: 12 }}>
        Times in {calendar.timezone}
      </div>
      {agenda.overdue.length > 0 && (
        <section aria-label="Overdue">
          <h4 style={{ color: UI_COLORS.danger, margin: "8px 0 4px" }}>
            Overdue
          </h4>
          {agenda.overdue.map((o) => (
            <Item
              key={`${o.event.id}@${o.date}`}
              o={o}
              calendar={calendar}
              showDate
              overdue
            />
          ))}
        </section>
      )}
      {agenda.days.length === 0 && agenda.overdue.length === 0 && (
        <div role="status">Nothing in the next 60 days.</div>
      )}
      {agenda.days.map((day) => (
        <section key={day.date} aria-label={dayLabel(day.date)}>
          <h4 style={{ margin: "12px 0 4px" }}>{dayLabel(day.date)}</h4>
          {day.occurrences.map((o) => (
            <Item key={`${o.event.id}@${o.date}`} o={o} calendar={calendar} />
          ))}
        </section>
      ))}
    </div>
  );
}

function Item({
  o,
  calendar,
  showDate,
  overdue,
}: {
  o: CalendarOccurrence;
  calendar: CocalcCalendar;
  showDate?: boolean;
  overdue?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { event } = o;
  const tz = calendar.timezone;
  const format = (ms: number, withDate: boolean, withTime: boolean) =>
    new Intl.DateTimeFormat(undefined, {
      ...(withDate ? { month: "short", day: "numeric" } : {}),
      ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
      timeZone: tz,
    }).format(new Date(ms));
  const allDay = event.all_day === true;
  const when = allDay
    ? showDate
      ? format(o.start, true, false)
      : "All day"
    : format(o.start, !!showDate, true);
  const category = event.category
    ? calendar.categories?.[event.category]
    : undefined;
  const status = event.status;
  const struck = status === "done" || status === "cancelled";
  const hasMore = !!(event.details || event.links?.length || event.owner);
  // A due date is due at the end of its day; a due time, at that time.
  const dueHasTime =
    event.due_offset_days == null &&
    event.due != null &&
    calendarTimeKind(event.due) !== "date";
  return (
    <div
      style={{
        borderLeft: `4px solid ${category?.color ?? UI_COLORS.border}`,
        padding: "4px 8px",
        margin: "4px 0",
        background: overdue ? UI_COLORS.dangerBg : undefined,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <span
          style={{ minWidth: 72, color: UI_COLORS.secondary, flexShrink: 0 }}
        >
          {when}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          {hasMore ? (
            <Button
              type="link"
              size="small"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              style={{
                padding: 0,
                height: "auto",
                whiteSpace: "normal",
                textAlign: "left",
                textDecoration: struck ? "line-through" : undefined,
              }}
            >
              {event.title}
            </Button>
          ) : (
            <span
              style={{ textDecoration: struck ? "line-through" : undefined }}
            >
              {event.title}
            </span>
          )}{" "}
          {category && (
            <Tag
              style={
                category.color
                  ? {
                      background: category.color,
                      borderColor: category.color,
                      color: readableOn(category.color),
                    }
                  : undefined
              }
            >
              {category.label}
            </Tag>
          )}
          {status && status !== "scheduled" && <Tag>{status}</Tag>}
          {o.due != null && (
            <span
              style={{
                color: overdue ? UI_COLORS.danger : UI_COLORS.secondary,
              }}
            >
              {" "}
              due {format(o.due, true, dueHasTime)}
            </span>
          )}
        </span>
      </div>
      {open && (
        <div style={{ margin: "4px 0 4px 80px" }}>
          {event.owner && (
            <div style={{ color: UI_COLORS.secondary }}>
              Owner: {event.owner}
            </div>
          )}
          {event.details && <StaticMarkdown value={event.details} />}
          {event.links
            ?.filter((link) => calendarLinkAllowed(link.url))
            .map((link) => (
              <div key={link.url}>
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  {link.label}
                </a>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
