/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Space, Spin } from "antd";
import { Buffer } from "buffer";
import { redux } from "@cocalc/frontend/app-framework";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import {
  joinAbsolutePath,
  normalizeAbsolutePath,
} from "@cocalc/util/path-model";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

interface FileEntry {
  name: string;
  directory: boolean;
}

export function AgentFileAttachment({
  projectId,
  workingDirectory,
  onInsert,
}: {
  projectId: string;
  workingDirectory?: string;
  onInsert: (markdown: string) => void;
}) {
  const home = getProjectHomeDirectory(projectId);
  const initialDirectory = normalizeAbsolutePath(
    workingDirectory || home,
    home,
  );
  const [open, setOpen] = useState(false);
  const [directory, setDirectory] = useState(initialDirectory);
  const [pathInput, setPathInput] = useState(initialDirectory);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    const fs = redux.getProjectActions(projectId)?.fs?.();
    if (!fs) {
      setError("Project filesystem unavailable");
      setLoading(false);
      return;
    }
    void (fs as any)
      .readdir(directory, { withFileTypes: true })
      .then(
        (items) => {
          if (cancelled) return;
          setEntries(
            (items ?? [])
              .map((item) => ({
                name: `${item.name ?? ""}`,
                directory:
                  typeof item.isDirectory === "function"
                    ? item.isDirectory()
                    : false,
              }))
              .filter((item) => item.name && item.name !== ".")
              .sort(
                (a, b) =>
                  Number(b.directory) - Number(a.directory) ||
                  a.name.localeCompare(b.name),
              ),
          );
        },
        (err) => {
          if (!cancelled) setError(String(err));
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [directory, open, projectId]);

  const choose = (path: string) => {
    const name = path.split("/").pop() || path;
    onInsert(`[${name}](sandbox:${path})`);
    setOpen(false);
  };

  const upload = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setLoading(true);
    setError("");
    try {
      const fs = redux.getProjectActions(projectId)?.fs?.();
      if (!fs) throw Error("Project filesystem unavailable");
      let target = joinAbsolutePath(directory, file.name);
      if (await fs.exists(target)) {
        const dot = file.name.lastIndexOf(".");
        const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
        const ext = dot > 0 ? file.name.slice(dot) : "";
        target = joinAbsolutePath(directory, `${stem}-${Date.now()}${ext}`);
      }
      await fs.writeFile(target, Buffer.from(await file.arrayBuffer()));
      choose(target);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  };

  return (
    <>
      <Tooltip title="Add a project file">
        <Button
          aria-label="Add project file"
          icon={<Icon name="upload" />}
          onClick={() => {
            setDirectory(initialDirectory);
            setPathInput(initialDirectory);
            setOpen(true);
          }}
          size="small"
          type="text"
        />
      </Tooltip>
      <Modal
        title="Add project file"
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        destroyOnHidden
      >
        <Space.Compact style={{ width: "100%", marginBottom: 8 }}>
          <Input
            aria-label="Project directory"
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            onPressEnter={() => {
              const next = normalizeAbsolutePath(pathInput, directory);
              setDirectory(next);
              setPathInput(next);
            }}
          />
          <Button
            onClick={() => {
              const next = normalizeAbsolutePath(pathInput, directory);
              setDirectory(next);
              setPathInput(next);
            }}
          >
            Go
          </Button>
        </Space.Compact>
        <Space wrap style={{ marginBottom: 8 }}>
          <Button
            disabled={directory === "/"}
            onClick={() => {
              const parent = normalizeAbsolutePath("..", directory);
              setDirectory(parent);
              setPathInput(parent);
            }}
          >
            Up
          </Button>
          <Button onClick={() => uploadRef.current?.click()}>
            <Icon name="upload" /> Upload here
          </Button>
          <input
            ref={uploadRef}
            type="file"
            hidden
            onChange={(event) => void upload(event.target.files)}
          />
        </Space>
        {error && (
          <Alert type="error" title={error} style={{ marginBottom: 8 }} />
        )}
        <div
          role="list"
          aria-label="Project files"
          style={{
            border: `1px solid ${UI_COLORS.border}`,
            borderRadius: 6,
            maxHeight: 360,
            minHeight: 160,
            overflow: "auto",
          }}
        >
          {loading ? (
            <div role="status" style={{ padding: 24, textAlign: "center" }}>
              <Spin /> Loading files...
            </div>
          ) : (
            entries.map((entry) => {
              const target = joinAbsolutePath(directory, entry.name);
              return (
                <Button
                  key={entry.name}
                  role="listitem"
                  type="text"
                  block
                  style={{ textAlign: "left" }}
                  icon={<Icon name={entry.directory ? "folder" : "file"} />}
                  onClick={() => {
                    if (entry.directory) {
                      setDirectory(target);
                      setPathInput(target);
                    } else {
                      choose(target);
                    }
                  }}
                >
                  {entry.name}
                </Button>
              );
            })
          )}
        </div>
        <div style={{ marginTop: 8, color: UI_COLORS.secondary }}>
          Choosing a file adds a visible saved-file reference to your draft.
        </div>
      </Modal>
    </>
  );
}
