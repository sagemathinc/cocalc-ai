/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "antd";
import { COLORS } from "@cocalc/util/theme";
import type {
  BackupCoverageView,
  BackupExcludedFileView,
} from "@cocalc/util/types/backup-coverage";

export interface BackupCoveragePanelProps {
  coverage: BackupCoverageView;
  // The controller saves in the authenticated account's home bay, then supplies
  // a fresh account-specific view. Local checked state is never evidence.
  acknowledge: (file: BackupExcludedFileView) => Promise<void>;
  downloadReport: () => Promise<void>;
  nextPage: (cursor: string) => Promise<void>;
}

function bytesLabel(value: string | null): string {
  if (value == null || !/^(0|[1-9][0-9]{0,19})$/.test(value))
    return "unknown size";
  try {
    return `${BigInt(value).toLocaleString("en-US")} bytes`;
  } catch {
    return "unknown size";
  }
}

// Display arbitrary Linux names without replacement-character aliases, hidden
// newlines or directional-control spoofing. Raw hex remains available too.
export function excludedPathLabel(hex: string): string {
  if (!/^(?:[0-9a-f]{2}){1,4096}$/.test(hex)) return "Invalid path encoding";
  const bytes = Uint8Array.from(hex.match(/../g)!, (pair) =>
    parseInt(pair, 16),
  );
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(
        /[\\\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
        (character) =>
          character === "\\"
            ? "\\\\"
            : `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
  } catch {
    return Array.from(bytes, (byte) =>
      byte >= 32 && byte <= 126 && byte !== 92
        ? String.fromCharCode(byte)
        : `\\x${byte.toString(16).padStart(2, "0")}`,
    ).join("");
  }
}

export default function BackupCoveragePanel({
  coverage,
  acknowledge,
  downloadReport,
  nextPage,
}: BackupCoveragePanelProps) {
  const detailsId = useId();
  const heading = useRef<HTMLButtonElement>(null);
  const details = useRef<HTMLDivElement>(null);
  const unacknowledged = coverage.unacknowledged_files !== "0";
  const [expanded, setExpanded] = useState(unacknowledged);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // An unchanged file in a new snapshot keeps its acknowledgement. New or
    // uncertain identities reopen the explanation, but never steal focus.
    if (!unacknowledged && details.current?.contains(document.activeElement))
      heading.current?.focus();
    setExpanded(unacknowledged);
  }, [unacknowledged, coverage.project_id]);

  async function perform(key: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch {
      setError(
        "The request failed. No acknowledgement was confirmed. Please try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  if (coverage.outcome === "failed") {
    return (
      <div role="status">
        The latest backup attempt failed or could not be verified. It does not
        establish that your current files are backed up. Existing backups are
        retained.
      </div>
    );
  }
  if (coverage.outcome === "complete") {
    return (
      <div role="status">
        Backup complete for its captured state. No oversized files were
        excluded. Later edits may still need a backup.
      </div>
    );
  }
  return (
    <section
      aria-label="Backup coverage"
      style={{ minWidth: 0, maxWidth: "100%" }}
    >
      <div role="status" style={{ marginBottom: 8 }}>
        Backup excludes {coverage.excluded_files} file(s).
        {!unacknowledged &&
          " You have acknowledged the current warnings; these files are still not backed up."}
      </div>
      <Button
        ref={heading}
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "Hide backup details" : "Show backup details"}
      </Button>
      {coverage.report_available && (
        <Button
          disabled={busy != null}
          onClick={() => void perform("download", downloadReport)}
          style={{ marginLeft: 8, marginTop: 4 }}
        >
          Download exclusion report
        </Button>
      )}
      {error && (
        <div role="alert" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}
      <div
        id={detailsId}
        ref={details}
        hidden={!expanded}
        style={{ marginTop: 12, overflowWrap: "anywhere" }}
      >
        <p>
          Files larger than {bytesLabel(coverage.exclude_larger_than_bytes)} are
          not backed up. Files exactly at the limit remain eligible. A dedicated
          VM supports workloads that need larger files.
        </p>
        <p>
          Acknowledging a warning only quiets it for you. It does not back up a
          file, hide warnings for collaborators, or permit a move, archive, or
          copy to omit that file.
        </p>
        <p>
          {coverage.unacknowledged_files} file warning(s) still need your
          acknowledgement.
        </p>
        <ul style={{ paddingInlineStart: 20, marginBottom: 8 }}>
          {coverage.files.map((file) => (
            <li key={file.path_hex} style={{ marginBottom: 12, minWidth: 0 }}>
              <div>
                <code style={{ whiteSpace: "pre-wrap" }}>
                  {excludedPathLabel(file.path_hex)}
                </code>{" "}
                ({bytesLabel(file.apparent_bytes)})
              </div>
              <label
                style={{ display: "flex", alignItems: "baseline", gap: 8 }}
              >
                <input
                  type="checkbox"
                  checked={file.acknowledged}
                  disabled={
                    file.acknowledged ||
                    file.acknowledgement_key == null ||
                    busy != null
                  }
                  onChange={() =>
                    void perform(file.path_hex, () => acknowledge(file))
                  }
                />
                <span>
                  I understand this file is not backed up:{" "}
                  {excludedPathLabel(file.path_hex)}
                </span>
              </label>
              {file.acknowledgement_key == null && (
                <div>
                  File identity could not be verified. This warning cannot be
                  acknowledged yet.
                </div>
              )}
              <details style={{ color: COLORS.GRAY_M }}>
                <summary>Exact path bytes</summary>
                <code>{file.path_hex}</code>
              </details>
            </li>
          ))}
        </ul>
        {coverage.next_cursor != null && (
          <Button
            disabled={busy != null}
            onClick={() =>
              void perform("next", () => nextPage(coverage.next_cursor!))
            }
          >
            Next excluded files
          </Button>
        )}
        {!coverage.report_available && (
          <p>
            The full exclusion report is unavailable. This is not proof of
            complete coverage.
          </p>
        )}
      </div>
    </section>
  );
}
