import { Button, Input, Select, Space, Spin } from "antd";
import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { default_filename } from "@cocalc/frontend/account";
import { useRedux } from "@cocalc/frontend/app-framework";
import ShowError from "@cocalc/frontend/components/error";
import { labels } from "@cocalc/frontend/i18n";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { path_split, plural } from "@cocalc/util/misc";
import CheckedFiles from "./checked-files";
import { join } from "path";
import { OUCH_FORMATS } from "@cocalc/conat/files/fs";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export const defaultFormat = OUCH_FORMATS.includes("tar.gz")
  ? "tar.gz"
  : OUCH_FORMATS[0];
export const ARCHIVE_TIMEOUT_MS = 10 * 60_000;
const DOWNLOAD_ARCHIVE_PATH = "/tmp";

const ARCHIVE_SUFFIXES = ["tar", ...OUCH_FORMATS].sort(
  (a, b) => b.length - a.length,
);

export default function CreateArchive({
  clear,
  display = "inline",
  onUserFilesystemChange,
}: {
  clear: () => void;
  display?: "inline" | "modal";
  onUserFilesystemChange?: () => void;
}) {
  const [format, setFormat] = useState<string>("");
  const intl = useIntl();
  const inputRef = useRef<any>(null);
  const { actions } = useProjectContext();
  const checked_files = useRedux(["checked_files"], actions?.project_id ?? "");
  const [target, setTarget] = useState<string>(() => {
    if (checked_files?.size == 1) {
      return path_split(checked_files?.first()).tail;
    }
    return default_filename("", actions?.project_id ?? "");
  });
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    setTimeout(() => {
      inputRef.current?.select();
    }, 1);
  }, []);

  const doCompress = async () => {
    if (actions == null) {
      return;
    }
    const store = actions.get_store();
    if (store == null) {
      return;
    }
    try {
      setLoading(true);
      const files = checked_files.toArray();
      const path = store.get("current_path_abs") ?? "/";
      onUserFilesystemChange?.();
      await createArchive({ path, files, target, format, actions });
      clear();
    } catch (err) {
      setLoading(false);
      setError(err);
    } finally {
      setLoading(false);
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
      <div style={{ marginBottom: "8px", fontWeight: 500 }}>Archive name</div>
      <Space style={{ width: "100%" }} wrap>
        <Input
          ref={inputRef}
          autoFocus
          onChange={(e) => setTarget(e.target.value)}
          value={target}
          placeholder="Name of archive..."
          onPressEnter={doCompress}
          suffix={"." + format}
        />
        <SelectFormat format={format} setFormat={setFormat} />
      </Space>
      <ShowError
        setError={setError}
        error={error}
        style={{ marginTop: "15px" }}
      />
      <div style={{ marginTop: "18px", textAlign: "right" }}>
        <Space wrap>
          <Button
            onClick={() => {
              actions?.set_file_action();
            }}
          >
            {intl.formatMessage(labels.cancel)}
          </Button>
          <Button onClick={doCompress} type="primary" disabled={loading}>
            Compress {checked_files?.size} {plural(checked_files?.size, "item")}{" "}
            {loading && <Spin />}
          </Button>
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
        Create a downloadable {format} archive from the following{" "}
        {checked_files?.size} selected {plural(checked_files?.size, "item")}
      </div>
      {content}
    </div>
  );
}

export async function createArchive({ path, files, target, format, actions }) {
  const fs = actions.fs();
  const archiveName = getArchiveTargetName(target, format);
  const finalPath = join(path, archiveName);
  const tmpPath = join(
    path,
    `.cocalc-archive-${Date.now()}-${Math.random().toString(36).slice(2)}-${archiveName}`,
  );
  try {
    await fs.rm(tmpPath, { force: true });
    const output = await fs.ouch(["compress", ...files, tmpPath], {
      timeout: ARCHIVE_TIMEOUT_MS,
    });
    const stderr = Buffer.from(output.stderr ?? Buffer.alloc(0)).toString();
    if (output.truncated) {
      throw Error(
        stderr ||
          `Archive creation exceeded the ${Math.round(
            ARCHIVE_TIMEOUT_MS / 60_000,
          )} minute timeout.`,
      );
    }
    if (output.code) {
      throw Error(
        stderr || `Archive creation failed with code ${output.code}.`,
      );
    }
    await fs.rename(tmpPath, finalPath);
    return finalPath;
  } catch (err) {
    try {
      await fs.rm(tmpPath, { force: true });
    } catch {
      // Best effort cleanup; preserve the original archive error.
    }
    throw err;
  }
}

export async function createDownloadArchive({
  files,
  target,
  format,
  actions,
}) {
  await ensureProjectScratchVolume(actions.project_id);
  return await createArchive({
    path: DOWNLOAD_ARCHIVE_PATH,
    files,
    target,
    format,
    actions,
  });
}

export async function removeDownloadArchive({
  path,
  actions,
}: {
  path: string;
  actions: any;
}) {
  const fs = actions.fs();
  await fs.rm(path, { force: true });
}

async function ensureProjectScratchVolume(project_id: string) {
  await webapp_client.conat_client.hub.projects.ensureProjectScratchVolume({
    project_id,
  });
}

export function getArchiveTargetName(target: string, format: string): string {
  let base = target.trim();
  for (const suffix of ARCHIVE_SUFFIXES) {
    const ext = `.${suffix}`;
    if (base.toLowerCase().endsWith(ext)) {
      base = base.slice(0, -ext.length);
      break;
    }
  }
  return `${base}.${format}`;
}

export function SelectFormat({ format, setFormat }) {
  useEffect(() => {
    if (!OUCH_FORMATS.includes(format)) {
      if (OUCH_FORMATS.includes(localStorage.defaultCompressionFormat)) {
        setFormat(localStorage.defaultCompressionFormat);
      } else {
        setFormat(defaultFormat);
      }
    }
  }, [format]);

  return (
    <Select
      value={format}
      style={{ width: "150px" }}
      options={OUCH_FORMATS.map((value) => {
        return { value };
      })}
      onChange={(format) => {
        setFormat(format);
        localStorage.defaultCompressionFormat = format;
      }}
    />
  );
}
