/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type {
  NotificationListRow,
  NotificationListSnapshot,
} from "@cocalc/conat/hub/api/notifications";
import { useEffect, useState } from "react";
import type { AuthBootstrap } from "./api";
import { Markdown, safeHref } from "./markdown";
import { UltraliteSession } from "./session";
import { EmptyState, InlineAlert, LoadingState, SurfaceHeader } from "./ui";

function notificationDate(row: NotificationListRow): string {
  const value = new Date(row.updated_at ?? row.created_at ?? "");
  return Number.isFinite(value.valueOf()) ? value.toLocaleString() : "";
}

export default function NotificationsSurface({
  bootstrap,
}: {
  bootstrap: AuthBootstrap;
}) {
  const [session, setSession] = useState<UltraliteSession>();
  const [snapshot, setSnapshot] = useState<NotificationListSnapshot>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    let opened: UltraliteSession | undefined;
    void UltraliteSession.open(bootstrap)
      .then(async (next) => {
        opened = next;
        if (!active) return;
        setSession(next);
        const value = await next.hubApi.notifications.listSnapshot({
          limit: 50,
          state: "all",
        });
        if (active) setSnapshot(value);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : `${err}`);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      opened?.close();
    };
  }, [bootstrap]);

  const markRead = async (row: NotificationListRow) => {
    if (!session || row.read_state?.read) return;
    setError(undefined);
    setSnapshot((current) =>
      current
        ? {
            ...current,
            rows: current.rows.map((item) =>
              item.notification_id === row.notification_id
                ? { ...item, read_state: { ...item.read_state, read: true } }
                : item,
            ),
          }
        : current,
    );
    try {
      await session.hubApi.notifications.markRead({
        notification_ids: [row.notification_id],
        read: true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : `${err}`);
    }
  };

  const markAllRead = async () => {
    if (!session || !snapshot) return;
    setError(undefined);
    try {
      await session.hubApi.notifications.markAllRead({
        project_id: null,
        read_through_revision: snapshot.read_through_revision,
      });
      setSnapshot({
        ...snapshot,
        rows: snapshot.rows.map((row) => ({
          ...row,
          read_state: { ...row.read_state, read: true },
        })),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : `${err}`);
    }
  };

  return (
    <main className="ul-page ul-account-page" id="main-content">
      <SurfaceHeader
        actions={
          <button
            className="ul-button ul-button-secondary"
            disabled={!snapshot?.rows.some((row) => !row.read_state?.read)}
            onClick={() => void markAllRead()}
            type="button"
          >
            Mark all read
          </button>
        }
        eyebrow="Account"
        title="Notifications"
      />
      <p className="ul-muted">
        Recent account notices, mentions, and Codex updates. This page loads on
        demand and does not poll in the background.
      </p>
      {loading ? <LoadingState label="Loading notifications" /> : null}
      {error ? <InlineAlert kind="error">{error}</InlineAlert> : null}
      <div className="ul-notification-list">
        {snapshot?.rows.map((row) => {
          const summary = row.summary ?? {};
          const body = `${summary.body_markdown ?? summary.description ?? ""}`;
          const action = safeHref(summary.action_link);
          const unread = !row.read_state?.read;
          return (
            <article
              className={`ul-notification ${unread ? "ul-notification-unread" : ""}`}
              key={row.notification_id}
            >
              <div className="ul-row-grid">
                <div>
                  <h2 className="ul-row-title ul-notification-title">
                    {`${summary.title ?? summary.origin_label ?? "Notification"}`}
                  </h2>
                  <div className="ul-row-detail">
                    {[summary.origin_label, notificationDate(row)]
                      .filter(Boolean)
                      .join(" - ")}
                  </div>
                </div>
                {unread ? <span className="ul-unread-dot">Unread</span> : null}
              </div>
              {body ? <Markdown source={body} /> : null}
              <div className="ul-toolbar">
                {action ? (
                  <a
                    className="ul-link-button ul-link-button-subtle"
                    href={action}
                    onClick={() => void markRead(row)}
                  >
                    {`${summary.action_label ?? "Open"}`}
                  </a>
                ) : null}
                {unread ? (
                  <button
                    className="ul-icon-button"
                    onClick={() => void markRead(row)}
                    type="button"
                  >
                    Mark read
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
      {!loading && !snapshot?.rows.length ? (
        <EmptyState>No recent notifications.</EmptyState>
      ) : null}
    </main>
  );
}
