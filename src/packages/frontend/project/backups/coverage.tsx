/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "antd";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  getBackupCoverage,
  getBackupCoverageReportChunk,
  getBackupAttempt,
} from "../archive-info";
import { validateBackupAcknowledgementKeys } from "@cocalc/util/backup-acknowledgements";
import type {
  BackupCoverageView,
  BackupExcludedFileView,
} from "@cocalc/util/types/backup-coverage";
import BackupCoveragePanel from "./coverage-panel";
import { downloadCoverageReport } from "./coverage-download";
import type { BackupAttemptStatus } from "@cocalc/util/types/backup-attempt";

// Remount on project change so late requests cannot mix identities or preferences.
export default function BackupCoverage({ project_id }: { project_id: string }) {
  return <CoverageController key={project_id} project_id={project_id} />;
}
function CoverageController({ project_id }: { project_id: string }) {
  const [coverage, setCoverage] = useState<BackupCoverageView | null>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState<BackupAttemptStatus | null>();
  const request = useRef(0);
  const mounted = useRef(false);
  const cancellation = useRef<AbortController | null>(null);

  async function refresh(backup_id?: string, cursor?: string | null) {
    const id = ++request.current;
    setLoading(true);
    setError(false);
    setAttempt(undefined);
    try {
      const latestAttempt = await getBackupAttempt({ project_id });
      if (!mounted.current || request.current !== id) return;
      if (latestAttempt && latestAttempt.project_id !== project_id)
        throw new Error("Invalid backup attempt response");
      setAttempt(latestAttempt);
      const keys = validateBackupAcknowledgementKeys(
        await webapp_client.conat_client.hub.projects.backupWarningAcknowledgements(
          { project_id },
        ),
      );
      const page = await getBackupCoverage({
        project_id,
        backup_id,
        cursor,
        acknowledgement_keys: keys,
      });
      if (!mounted.current || request.current !== id) return;
      if (page == null) {
        setCoverage(null);
        return;
      }
      const acknowledged = new Set(keys);
      if (
        page.project_id !== project_id ||
        (backup_id && page.backup_id !== backup_id) ||
        BigInt(page.acknowledged_files) > BigInt(page.excluded_files)
      )
        throw new Error("Invalid backup coverage response");
      setCoverage({
        schema_version: 1,
        ...page,
        unacknowledged_files: String(
          BigInt(page.excluded_files) - BigInt(page.acknowledged_files),
        ),
        files: page.files.map((file) => ({
          ...file,
          acknowledged:
            file.acknowledgement_key != null &&
            acknowledged.has(file.acknowledgement_key),
        })),
        report_available: true,
      });
    } catch (err) {
      if (mounted.current && request.current === id) {
        setError(true);
        setCoverage(undefined);
      }
      throw err;
    } finally {
      if (mounted.current && request.current === id) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    cancellation.current = new AbortController();
    void refresh().catch(() => {});
    return () => {
      mounted.current = false;
      request.current++;
      cancellation.current?.abort();
    };
  }, [project_id]);

  async function acknowledge(file: BackupExcludedFileView) {
    if (!coverage || !file.acknowledgement_key)
      throw new Error("File identity unavailable");
    await webapp_client.conat_client.hub.projects.backupWarningAcknowledgements(
      { project_id, key: file.acknowledgement_key },
    );
    // Reload authoritative preferences. Never count a checkbox click as success.
    await refresh(coverage.backup_id!);
  }
  async function download() {
    if (!coverage?.backup_id || !cancellation.current)
      throw new Error("Backup report unavailable");
    const backup_id = coverage.backup_id;
    const blob = await downloadCoverageReport(
      backup_id,
      (offset) =>
        getBackupCoverageReportChunk({ project_id, backup_id, offset }),
      cancellation.current.signal,
    );
    if (!mounted.current) return;
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `backup-exclusions-${backup_id}.ndjson`;
      anchor.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  return (
    <div style={{ minWidth: 0 }}>
      {attempt?.outcome === "failed" && (
        <p role="alert">
          The latest backup attempt failed. Older backups are retained, but a
          previous coverage report does not confirm that current files are
          backed up.
        </p>
      )}
      {attempt?.outcome === "unconfirmed" && (
        <p role="status">
          Completion of the latest backup attempt has not been confirmed. It may
          still be running or may have been interrupted. A previous coverage
          report is not confirmation of this attempt's success.
        </p>
      )}
      {error && (
        <p role="alert">
          Backup coverage could not be verified. Existing backups are retained;
          this is not confirmation that all current files are backed up.
        </p>
      )}
      {!error && coverage === null && (
        <p role="status">
          No verified backup coverage report is available for this project yet.
          Older backups may still be available.
        </p>
      )}
      {loading && !coverage && <p role="status">Loading backup coverage...</p>}
      {coverage && (
        <BackupCoveragePanel
          coverage={coverage}
          acknowledge={acknowledge}
          downloadReport={download}
          nextPage={(cursor) => refresh(coverage.backup_id!, cursor)}
        />
      )}
      <Button disabled={loading} onClick={() => void refresh().catch(() => {})}>
        Refresh backup coverage
      </Button>
    </div>
  );
}
