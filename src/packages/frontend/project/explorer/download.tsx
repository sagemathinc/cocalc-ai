import { Button, Input, Progress, Space, Spin } from "antd";
import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { default_filename } from "@cocalc/frontend/account";
import { useRedux } from "@cocalc/frontend/app-framework";
import ShowError from "@cocalc/frontend/components/error";
import { Icon } from "@cocalc/frontend/components/icon";
import { labels } from "@cocalc/frontend/i18n";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { human_readable_size, path_split, plural } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import { PRE_STYLE } from "./action-box";
import CheckedFiles from "./checked-files";
import {
  SelectFormat,
  createDownloadArchive,
  type DownloadArchiveProgressStage,
  removeDownloadArchive,
} from "./create-archive";

const ARCHIVE_ESTIMATE_BYTES_PER_SECOND = 25 * 1024 * 1024;
const MIN_ARCHIVE_ESTIMATE_SECONDS = 4;
const DIRECTORY_ARCHIVE_ESTIMATE_SECONDS = 5;
const UNKNOWN_FILE_ARCHIVE_ESTIMATE_SECONDS = 2;

type DownloadProgress = {
  phase: string;
  detail?: string;
  percent: number;
  startedAt: number;
  estimateSeconds: number;
  startPercent: number;
  maxPercent: number;
};

type ArchiveEstimate = {
  seconds: number;
  detail: string;
};

export default function Download({
  clear,
  display = "inline",
}: {
  clear: () => void;
  display?: "inline" | "modal";
}) {
  const [format, setFormat] = useState<string>("");
  const intl = useIntl();
  const inputRef = useRef<any>(null);
  const { actions } = useProjectContext();
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const project_id = actions?.project_id ?? "";
  const current_path_abs = useRedux(["current_path_abs"], project_id);
  const effective_current_path = current_path_abs ?? "/";
  const checked_files = useRedux(["checked_files"], project_id);
  const [target, setTarget] = useState<string>(() => {
    if (checked_files?.size == 1) {
      return path_split(checked_files?.first()).tail;
    }
    return default_filename("", actions?.project_id ?? "");
  });
  const [url, setUrl] = useState<string>("todo");
  const [archiveMode, setArchiveMode] = useState<boolean>(
    (checked_files?.size ?? 0) > 1,
  );
  const [progress, setProgress] = useState<DownloadProgress | null>(null);

  useEffect(() => {
    if (progress == null || progress.percent >= progress.maxPercent) {
      return;
    }
    const interval = setInterval(() => {
      setProgress((prev) => {
        if (prev == null) {
          return prev;
        }
        const elapsedSeconds = Math.max(
          0,
          (Date.now() - prev.startedAt) / 1000,
        );
        const ratio = Math.min(
          0.98,
          elapsedSeconds / Math.max(1, prev.estimateSeconds),
        );
        const percent = Math.min(
          prev.maxPercent,
          Math.max(
            prev.percent,
            Math.round(
              prev.startPercent + (prev.maxPercent - prev.startPercent) * ratio,
            ),
          ),
        );
        return percent === prev.percent ? prev : { ...prev, percent };
      });
    }, 500);
    return () => clearInterval(interval);
  }, [progress?.phase, progress?.startedAt, progress?.maxPercent]);

  useEffect(() => {
    if (actions == null) {
      return;
    }
    if (checked_files == null) {
      return;
    }
    if (checked_files.size > 1) {
      setArchiveMode(true);
      return;
    }
    const file = checked_files.first();
    const isDir = !!actions.isDirViaCache(file);
    setArchiveMode(!!isDir);
    if (!isDir) {
      const store = actions?.get_store();
      setUrl(store?.fileURL(file) ?? "");
    }
  }, [checked_files, effective_current_path]);

  useEffect(() => {
    if (!archiveMode) {
      return;
    }
    if (checked_files?.size == 1) {
      setTarget(path_split(checked_files?.first()).tail);
    } else {
      setTarget(default_filename("", actions?.project_id ?? ""));
    }

    setTimeout(() => {
      inputRef.current?.select();
    }, 1);
  }, [archiveMode]);

  const doDownload = async () => {
    if (actions == null || loading) {
      return;
    }
    let success = false;
    let temporaryArchivePath: string | undefined;
    try {
      setLoading(true);
      setProgress(null);
      const files = checked_files.toArray();
      const archiveEstimate = archiveMode
        ? estimateArchiveProgress({
            actions,
            files,
            currentPath: effective_current_path,
          })
        : undefined;
      let dest;
      let downloadFilename: string | undefined;
      let deleteAfterDownload = false;
      if (archiveMode) {
        const setArchiveProgress = (stage: DownloadArchiveProgressStage) => {
          const next = progressForArchiveStage(stage, archiveEstimate);
          setProgress((prev) => ({
            ...next,
            startedAt: Date.now(),
            startPercent: Math.max(prev?.percent ?? 0, next.startPercent),
            percent: Math.max(prev?.percent ?? 0, next.startPercent),
          }));
        };
        const archive = await createDownloadArchive({
          files,
          target,
          format,
          actions,
          onProgress: setArchiveProgress,
        });
        dest = archive.path;
        downloadFilename = archive.filename;
        deleteAfterDownload = true;
        temporaryArchivePath = archive.path;
      } else {
        dest = files[0];
      }
      setProgress((prev) => ({
        phase: "Starting browser download",
        detail:
          archiveMode && downloadFilename != null
            ? `Created ${downloadFilename}.`
            : undefined,
        percent: Math.max(prev?.percent ?? 0, 92),
        startedAt: Date.now(),
        estimateSeconds: 3,
        startPercent: Math.max(prev?.percent ?? 0, 92),
        maxPercent: 98,
      }));
      await actions.download_file({
        path: dest,
        log: files,
        showError: false,
        deleteAfterDownload,
        downloadFilename,
      });
      setProgress((prev) =>
        prev == null
          ? prev
          : { ...prev, phase: "Download started", percent: 100 },
      );
      success = true;
    } catch (err) {
      setError(`${err}`);
    } finally {
      if (temporaryArchivePath != null && !success) {
        try {
          await removeDownloadArchive({
            path: temporaryArchivePath,
            actions,
          });
        } catch (err) {
          setError((prev) =>
            prev ? `${prev}\nCleanup failed: ${err}` : `Cleanup failed: ${err}`,
          );
        }
      }
      setLoading(false);
      if (!success) {
        setProgress(null);
      }
    }

    if (success) {
      clear();
    }
  };

  if (actions == null) {
    return null;
  }

  const content = (
    <>
      <CheckedFiles
        variant={display === "modal" ? "compact" : "block"}
        maxVisible={3}
      />
      {archiveMode && (
        <div style={{ marginBottom: "12px" }}>
          <div style={{ marginBottom: "8px", fontWeight: 500 }}>
            Archive name
          </div>
          <Space style={{ width: "100%" }} wrap>
            <Input
              ref={inputRef}
              autoFocus
              onChange={(e) => setTarget(e.target.value)}
              value={target}
              placeholder={`Name of ${format} archive...`}
              onPressEnter={doDownload}
              suffix={"." + format}
            />
            <SelectFormat format={format} setFormat={setFormat} />
          </Space>
        </div>
      )}
      {!archiveMode && (
        <div
          style={{
            overflowX: "auto",
            display: "flex",
            marginBottom: "12px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              height: PRE_STYLE.minHeight,
              marginRight: "15px",
            }}
          >
            <a href={url} target="_blank">
              <Icon name="external-link" />
            </a>
          </div>
          <pre style={{ ...PRE_STYLE, height: PRE_STYLE.minHeight, flex: 1 }}>
            <a href={url} target="_blank">
              {url}
            </a>
          </pre>
        </div>
      )}
      <ShowError setError={setError} error={error} />
      {loading && (
        <div
          style={{
            marginTop: "14px",
            padding: "12px",
            border: `1px solid ${COLORS.GRAY_DDD}`,
            borderRadius: "6px",
            background: COLORS.GRAY_LLL,
          }}
        >
          <Progress
            percent={progress?.percent ?? 1}
            status="active"
            showInfo={false}
            size="small"
          />
          <div style={{ marginTop: "8px", fontWeight: 500 }}>
            {progress?.phase ?? "Preparing download"}
          </div>
          {progress?.detail && (
            <div style={{ color: COLORS.GRAY_M, marginTop: "4px" }}>
              {progress.detail}
            </div>
          )}
          {archiveMode && (
            <div style={{ color: COLORS.GRAY_M, marginTop: "6px" }}>
              You can close this dialog; the archive and download request will
              continue in the background. CoCalc stores the temporary archive as
              a hidden file in <code>/tmp</code> and automatically cleans up
              stale hidden download archives after about 6 hours.
            </div>
          )}
        </div>
      )}
      <div style={{ marginTop: "18px", textAlign: "right" }}>
        <Space wrap>
          <Button
            onClick={() => {
              actions?.set_file_action();
            }}
          >
            {intl.formatMessage(labels.cancel)}
          </Button>
          {archiveMode ? (
            <Button onClick={doDownload} type="primary" disabled={loading}>
              <Icon name="cloud-download" /> Compress {checked_files?.size}{" "}
              {plural(checked_files?.size, "item")} and download {target}.
              {format} {loading && <Spin />}
            </Button>
          ) : (
            <Button onClick={doDownload} type="primary" disabled={loading}>
              <Icon name="cloud-download" /> Download {loading && <Spin />}
            </Button>
          )}
        </Space>
      </div>
    </>
  );

  if (display === "modal") {
    return content;
  }

  return (
    <div>
      <div style={{ marginBottom: "10px", fontWeight: 500 }}>
        Download {archiveMode ? "files" : "a file"} to your computer
      </div>
      {content}
    </div>
  );
}

function progressForArchiveStage(
  stage: DownloadArchiveProgressStage,
  archiveEstimate: ArchiveEstimate | undefined,
): Omit<DownloadProgress, "startedAt"> {
  switch (stage) {
    case "scratch":
      return {
        phase: "Preparing temporary archive storage",
        percent: 2,
        estimateSeconds: 2,
        startPercent: 2,
        maxPercent: 12,
      };
    case "cleanup":
      return {
        phase: "Cleaning old temporary download archives",
        percent: 12,
        estimateSeconds: 2,
        startPercent: 12,
        maxPercent: 20,
      };
    case "compress":
      return {
        phase: "Compressing selected items",
        detail: archiveEstimate?.detail,
        percent: 20,
        estimateSeconds: archiveEstimate?.seconds ?? 10,
        startPercent: 20,
        maxPercent: 90,
      };
  }
}

function estimateArchiveProgress({
  actions,
  files,
  currentPath,
}: {
  actions: any;
  files: string[];
  currentPath: string;
}): ArchiveEstimate {
  const cachedFiles = actions.get_filenames_in_current_dir?.();
  let knownBytes = 0;
  let directories = 0;
  let unknown = 0;

  for (const file of files) {
    const { head, tail } = path_split(file);
    const data = head === currentPath ? cachedFiles?.[tail] : undefined;
    if (data?.isDir) {
      directories += 1;
    } else if (Number.isFinite(data?.size) && data.size > 0) {
      knownBytes += data.size;
    } else {
      unknown += 1;
    }
  }

  const seconds = Math.max(
    MIN_ARCHIVE_ESTIMATE_SECONDS,
    Math.ceil(
      knownBytes / ARCHIVE_ESTIMATE_BYTES_PER_SECOND +
        directories * DIRECTORY_ARCHIVE_ESTIMATE_SECONDS +
        unknown * UNKNOWN_FILE_ARCHIVE_ESTIMATE_SECONDS,
    ),
  );

  const details: string[] = [];
  if (knownBytes > 0) {
    details.push(
      `estimate based on ${human_readable_size(knownBytes)} of known file data`,
    );
  }
  if (directories > 0) {
    details.push(
      `${directories} ${plural(
        directories,
        "directory",
      )} may take longer because recursive sizes are not precomputed`,
    );
  }
  if (unknown > 0) {
    details.push(`${unknown} ${plural(unknown, "item")} with unknown size`);
  }

  return {
    seconds,
    detail:
      details.length > 0
        ? `${details.join("; ")}.`
        : "Best-effort estimate; exact compression progress is not available.",
  };
}
