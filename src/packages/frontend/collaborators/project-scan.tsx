/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useRef, useState } from "react";
import { Button, Space } from "antd";
import { uuid } from "@cocalc/util/misc";
import type { DirectoryApi } from "./workspace-api";

/** Mount with an account/project key. Reads are manual, never background work. */
export function ProjectScan({
  api,
  accountId,
  projectId,
}: {
  api: DirectoryApi;
  accountId: string;
  projectId: string;
}) {
  const key = `people-scan:${accountId}:${projectId}`;
  const [requestId, setRequestId] = useState(() => {
    try {
      const saved = sessionStorage.getItem(key);
      return saved && /^[0-9a-f-]{36}$/i.test(saved) ? saved : undefined;
    } catch {
      return undefined;
    }
  });
  const [jobId, setJobId] = useState<string>();
  const [message, setMessage] = useState(
    requestId
      ? "A previous Scan request is saved. Check its outcome before retrying."
      : "Discover conversations and other People metadata in this project. This does not start project compute.",
  );
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(true);
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [finished, setFinished] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const wasFinished = useRef(false);
  useEffect(() => {
    if (finished || wasFinished.current) statusRef.current?.focus();
    wasFinished.current = finished;
  }, [finished]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (until <= Date.now()) {
      setNow(Date.now());
      return;
    }
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= until) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [until]);
  const cooldown = Math.max(0, Math.ceil((until - now) / 1000));
  const delay = (ms: number) => {
    const time = Date.now();
    setNow(time);
    setUntil(time + Math.max(1000, ms));
  };
  async function run(action: "send" | "inspect") {
    if (locked.current || Date.now() < until) return;
    locked.current = true;
    setBusy(true);
    try {
      if (action === "send") {
        const id = requestId ?? uuid();
        // Save before sending so a lost response or navigation is recoverable.
        try {
          sessionStorage.setItem(key, id);
        } catch {
          setMessage(
            "Scan was not sent: this browser could not save a recovery identifier. Enable session storage and try again.",
          );
          return;
        }
        setRequestId(id);
        const result = await api.requestScan!({
          project_id: projectId,
          request_id: id,
          mode: "reconcile",
        });
        if (!mounted.current) return;
        if (result.admission === "throttled") {
          delay(result.retry_after_ms);
          setMessage(
            "Scan is throttled. Retry the same request after the cooldown.",
          );
        } else {
          setJobId(result.job_id);
          setMessage(
            result.admission === "coalesced"
              ? "Joined an existing Scan. Check status for discovery progress."
              : "Scan queued. Check status for discovery progress.",
          );
          delay(5000);
        }
      } else if (!jobId) {
        const result = await api.inspectScan!({
          project_id: projectId,
          request_id: requestId!,
        });
        if (!mounted.current) return;
        delay(result.allowed ? result.poll_after_ms : result.retry_after_ms);
        if (!result.allowed)
          setMessage(
            "Status checks are throttled. Wait before checking again.",
          );
        else if (result.value) {
          setJobId(result.value.job_id);
          setMessage(
            "Scan receipt recovered. Check status for discovery progress.",
          );
        } else
          setMessage(
            "No live receipt found. It may be unsubmitted or expired. Retrying uses the same request ID.",
          );
      } else {
        const result = await api.getScanStatus!({
          project_id: projectId,
          job_id: jobId,
        });
        if (!mounted.current) return;
        delay(result.allowed ? result.poll_after_ms : result.retry_after_ms);
        if (!result.allowed)
          setMessage(
            "Status checks are throttled. Wait before checking again.",
          );
        else {
          const state = result.value.state;
          setMessage(
            {
              unknown:
                "No live status is available. The receipt may have expired; no new Scan was started.",
              queued: "Scan queued. No completion estimate is available yet.",
              running:
                "Discovering project metadata. No completion estimate is available yet.",
              discovered:
                "Discovery finished. People views may still be catching up; this is not a guarantee that every view is current.",
              failed:
                "Scan failed. You can request another Scan after the cooldown.",
            }[state],
          );
          if (
            state === "discovered" ||
            state === "failed" ||
            state === "unknown"
          ) {
            sessionStorage.removeItem(key);
            setFinished(true);
          }
        }
      }
    } catch {
      if (mounted.current) {
        setMessage(
          "Scan outcome could not be confirmed. Check status or retry the same request; authorization or service availability may have changed.",
        );
        delay(5000);
      }
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  if (!api.requestScan || !api.inspectScan || !api.getScanStatus) return null;
  return (
    <section
      aria-label="Project metadata scan"
      style={{ padding: "12px 0", overflowWrap: "anywhere" }}
    >
      <p role="status" ref={statusRef} tabIndex={-1}>
        {message}
      </p>
      <Space wrap>
        {finished ? (
          <Button
            disabled={busy || cooldown > 0}
            onClick={() => {
              setRequestId(undefined);
              setJobId(undefined);
              setFinished(false);
              setMessage("Ready to request another Scan.");
            }}
          >
            New Scan
          </Button>
        ) : (
          <>
            <Button
              disabled={busy || cooldown > 0 || !!jobId}
              onClick={() => void run("send")}
            >
              {requestId ? "Retry same Scan" : "Scan project"}
            </Button>
            {requestId && (
              <Button
                disabled={busy || cooldown > 0}
                onClick={() => void run("inspect")}
              >
                Check Scan status
              </Button>
            )}
          </>
        )}
        {cooldown > 0 && <span>Available in {cooldown}s</span>}
      </Space>
      {requestId && (
        <details>
          <summary>Scan identifiers</summary>
          <div>Request: {requestId}</div>
          {jobId && <div>Job: {jobId}</div>}
        </details>
      )}
    </section>
  );
}
