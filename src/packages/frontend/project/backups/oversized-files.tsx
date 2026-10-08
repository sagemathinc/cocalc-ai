/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Checkbox, Modal, Space } from "antd";
import { useState, type CSSProperties } from "react";
import { getOversizedFiles } from "@cocalc/frontend/project/archive-info";
import {
  hasOversizedFiles,
  type OversizedFilesReport,
} from "@cocalc/util/consts/backups";
import { human_readable_size } from "@cocalc/util/misc";

export function OversizedFilesNotice({
  report,
  title,
  future = false,
  style,
}: {
  report: OversizedFilesReport;
  title: string;
  // Describe files that will be skipped rather than files that were.
  future?: boolean;
  style?: CSSProperties;
}) {
  const more = report.count - report.files.length;
  const one = report.count === 1;
  return (
    <Alert
      type="warning"
      showIcon
      style={style}
      title={title}
      description={
        <>
          <div>
            {one ? "1 file is" : `${report.count} files are`} larger than this
            project's {human_readable_size(report.max_file_bytes)} backup file
            size limit and{" "}
            {future ? "will not be" : one ? "was not" : "were not"} included:
          </div>
          <ul style={{ margin: "4px 0 0 0", paddingLeft: "20px" }}>
            {report.files.map(({ path, size }) => (
              <li key={path}>
                <code>{path}</code> ({human_readable_size(size)})
              </li>
            ))}
            {more > 0 ? <li>and {more} more</li> : null}
          </ul>
        </>
      }
    />
  );
}

function OversizedFilesConfirmation({
  report,
  consequence,
  onConfirmedChange,
}: {
  report: OversizedFilesReport;
  consequence: string;
  onConfirmedChange: (confirmed: boolean) => void;
}) {
  const [confirmed, setConfirmed] = useState<boolean>(false);
  return (
    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
      <OversizedFilesNotice
        report={report}
        title="Some files cannot be included"
        future
      />
      <div>{consequence}</div>
      <Checkbox
        checked={confirmed}
        onChange={(e) => {
          setConfirmed(e.target.checked);
          onConfirmedChange(e.target.checked);
        }}
      >
        I understand that {report.count === 1 ? "this file" : "these files"}{" "}
        will not be included.
      </Checkbox>
    </Space>
  );
}

export async function confirmOversizedFiles({
  report,
  title,
  okText,
  consequence,
}: {
  report: OversizedFilesReport;
  title: string;
  okText: string;
  consequence: string;
}): Promise<boolean> {
  return await new Promise((resolve) => {
    const instance = Modal.confirm({
      title,
      width: 600,
      content: (
        <OversizedFilesConfirmation
          report={report}
          consequence={consequence}
          onConfirmedChange={(confirmed) =>
            instance.update({
              okButtonProps: { danger: true, disabled: !confirmed },
            })
          }
        />
      ),
      okText,
      okButtonProps: { danger: true, disabled: true },
      cancelText: "Cancel",
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

// Before an operation that restores from a backup, show the files the backup
// will leave out and ask the user to confirm. Pass allow_oversized_skip on to
// the operation; the server refuses to skip files without it. If the check
// itself fails, proceed without confirmation and let the server decide.
export async function checkOversizedFiles({
  project_id,
  paths,
  title,
  okText,
  consequence,
}: {
  project_id: string;
  paths?: string[];
  title: string;
  okText: string;
  consequence: string;
}): Promise<{ proceed: boolean; allow_oversized_skip: boolean }> {
  let report: OversizedFilesReport | null;
  try {
    report = await getOversizedFiles({ project_id, paths });
  } catch (err) {
    console.warn("unable to check for files over the backup limit", err);
    return { proceed: true, allow_oversized_skip: false };
  }
  if (!hasOversizedFiles(report)) {
    return { proceed: true, allow_oversized_skip: false };
  }
  const proceed = await confirmOversizedFiles({
    report,
    title,
    okText,
    consequence,
  });
  return { proceed, allow_oversized_skip: proceed };
}
