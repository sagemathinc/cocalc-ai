/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Dropdown,
  Input,
  Modal,
  Popover,
  Space,
  Spin,
} from "antd";
import type { MenuProps } from "antd";
import { Buffer } from "buffer";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import {
  joinAbsolutePath,
  normalizeAbsolutePath,
} from "@cocalc/util/path-model";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { VmToolbox } from "@cocalc/frontend/agents/vm-toolbox";
import { FileGrants } from "@cocalc/frontend/agents/file-grants";
import { fileGrantsForAgent } from "@cocalc/frontend/agents/file-grants-service";
import {
  readVmToolbox,
  VM_TOOLBOX_SETTING,
} from "@cocalc/frontend/agents/vm-toolbox-model";

interface FileEntry {
  name: string;
  directory: boolean;
}

export function AgentFileAttachment({
  projectId,
  path,
  threadId,
  workingDirectory,
  onInsert,
  onSetGoal,
  disabled = false,
}: {
  projectId: string;
  path?: string;
  threadId?: string;
  workingDirectory?: string;
  onInsert: (markdown: string) => void;
  onSetGoal?: () => void;
  disabled?: boolean;
}) {
  const settings = useTypedRedux("account", "other_settings");
  const [toolboxOpen, setToolboxOpen] = useState(false);
  const [fileGrantsOpen, setFileGrantsOpen] = useState(false);
  const [fileSummaryOpen, setFileSummaryOpen] = useState(false);
  const [fileGrantTarget, setFileGrantTarget] = useState<string>();
  const [fileGrantCount, setFileGrantCount] = useState(0);
  const vmCount =
    readVmToolbox(settings?.get?.(VM_TOOLBOX_SETTING)).find(
      (item) =>
        item.projectId === projectId &&
        item.path === path &&
        item.threadId === threadId,
    )?.vms.length ?? 0;
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
    if (!path || !threadId) return;
    let disposed = false;
    void fileGrantsForAgent({ projectId, path, threadId }).then(
      ({ grants }) => !disposed && setFileGrantCount(grants.length),
      () => undefined,
    );
    return () => {
      disposed = true;
    };
  }, [path, projectId, threadId]);

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

  const insertPaths = (paths: string[]) => {
    if (!paths.length) return;
    onInsert(
      paths
        .map((path) => {
          const name = path.split("/").pop() || path;
          return `[${name}](sandbox:${path})`;
        })
        .join(" "),
    );
  };

  const choose = (path: string) => {
    insertPaths([path]);
    setOpen(false);
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setLoading(true);
    setError("");
    try {
      const fs = redux.getProjectActions(projectId)?.fs?.();
      if (!fs) throw Error("Project filesystem unavailable");
      const targets: string[] = [];
      for (const file of Array.from(files)) {
        let target = joinAbsolutePath(directory, file.name);
        if (await fs.exists(target)) {
          const dot = file.name.lastIndexOf(".");
          const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
          const ext = dot > 0 ? file.name.slice(dot) : "";
          target = joinAbsolutePath(directory, `${stem}-${Date.now()}${ext}`);
        }
        await fs.writeFile(target, Buffer.from(await file.arrayBuffer()));
        targets.push(target);
      }
      insertPaths(targets);
      setOpen(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  };

  const menu: MenuProps = {
    items: [
      {
        key: "upload",
        icon: <Icon name="upload" />,
        label: "Upload files",
      },
      {
        key: "choose",
        icon: <Icon name="folder-open" />,
        label: "Choose project files",
      },
      ...(path && threadId
        ? [
            {
              key: "vm",
              icon: <Icon name="server" />,
              label: "Virtual machine...",
            },
            {
              key: "file-grants",
              icon: <Icon name="folder-open" />,
              label: "Files from another project...",
            },
          ]
        : []),
      ...(onSetGoal
        ? [
            { type: "divider" as const },
            {
              key: "goal",
              icon: <Icon name="list" />,
              label: "Set goal",
            },
          ]
        : []),
    ],
    onClick: ({ key }) => {
      if (key === "upload") uploadRef.current?.click();
      if (key === "choose") setOpen(true);
      if (key === "goal") onSetGoal?.();
      if (key === "vm") setToolboxOpen(true);
      if (key === "file-grants") {
        setFileGrantTarget(undefined);
        setFileGrantsOpen(true);
      }
    },
  };

  return (
    <>
      <Tooltip title="Add files and more">
        <Dropdown
          menu={menu}
          trigger={["click"]}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) return;
            setDirectory(initialDirectory);
            setPathInput(initialDirectory);
          }}
        >
          <Button
            aria-label="Add files and more"
            aria-haspopup="menu"
            disabled={disabled}
            icon={<Icon name="plus" />}
            shape="circle"
            style={{ height: 32, minWidth: 32, width: 32 }}
            type="text"
          />
        </Dropdown>
      </Tooltip>
      {path && threadId && (
        <>
          {vmCount > 0 && (
            <Button
              type="text"
              aria-label={`VM toolbox, ${vmCount} attached`}
              icon={<Icon name="server" />}
              onClick={() => setToolboxOpen(true)}
            >
              {vmCount}
            </Button>
          )}
          {fileGrantCount > 0 && (
            <Popover
              trigger="click"
              open={fileSummaryOpen}
              onOpenChange={setFileSummaryOpen}
              content={
                <FileGrants
                  projectId={projectId}
                  path={path}
                  threadId={threadId}
                  open={fileSummaryOpen}
                  summary
                  onEdit={(target) => {
                    setFileSummaryOpen(false);
                    setFileGrantTarget(target);
                    setFileGrantsOpen(true);
                  }}
                  onClose={() => setFileSummaryOpen(false)}
                  onCountChange={setFileGrantCount}
                />
              }
            >
              <Button
                type="text"
                aria-label={`File grants, ${fileGrantCount} attached`}
                icon={<Icon name="folder-open" />}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setFileSummaryOpen(false);
                }}
              >
                {fileGrantCount}
              </Button>
            </Popover>
          )}
          <VmToolbox
            projectId={projectId}
            path={path}
            threadId={threadId}
            open={toolboxOpen}
            onClose={() => setToolboxOpen(false)}
          />
          <FileGrants
            projectId={projectId}
            path={path}
            threadId={threadId}
            open={fileGrantsOpen}
            initialTargetProjectId={fileGrantTarget}
            onClose={() => setFileGrantsOpen(false)}
            onCountChange={setFileGrantCount}
          />
        </>
      )}
      <input
        ref={uploadRef}
        type="file"
        hidden
        multiple
        onChange={(event) => void upload(event.target.files)}
      />
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
                  style={{ justifyContent: "flex-start", textAlign: "left" }}
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
