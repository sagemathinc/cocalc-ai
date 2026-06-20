/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Modal, Radio, Space, message } from "antd";
import * as immutable from "immutable";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Button } from "@cocalc/frontend/antd-bootstrap";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { Icon, type MenuItems } from "@cocalc/frontend/components";
import { useStudentProjectFunctionality } from "@cocalc/frontend/course";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import { labels } from "@cocalc/frontend/i18n";
import { type ProjectActions } from "@cocalc/frontend/project_store";
import * as misc from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import { DirectoryListingEntry } from "@cocalc/util/types";
import {
  ACTION_BUTTONS_DIR,
  ACTION_BUTTONS_FILE,
  ACTION_BUTTONS_MULTI,
} from "@cocalc/frontend/project/explorer/action-utils";
import { FileActionsDropdown } from "@cocalc/frontend/project/explorer/file-actions-dropdown";
import {
  BACKUPS,
  type BackupMeta,
  isBackupsPath,
} from "@cocalc/frontend/project/listing/use-backups";
import { getBackups } from "@cocalc/frontend/project/archive-info";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import path from "path";
import {
  AutoUpdateButton,
  RefreshButton,
} from "@cocalc/frontend/project/explorer/refresh-button";

const ROW_INFO_STYLE = {
  alignItems: "center",
  color: COLORS.TAB,
  display: "inline-flex",
  height: "32px",
  margin: "0 3px",
} as const;

interface Props {
  project_id?: string;
  checked_files: immutable.Set<string>;
  listing: DirectoryListingEntry[];
  current_path: string;
  actions: ProjectActions;
  refreshBackups?: () => void;
  hasPendingUpdate?: boolean;
  onRefreshListing?: () => void;
  autoUpdateListing?: boolean;
  onToggleAutoUpdate?: (checked: boolean) => void;
  suppressPendingRefresh?: boolean;
  readOnly?: boolean;
  allowCopyOut?: boolean;
}

export function ActionBar(props: Props) {
  const studentProjectFunctionality = useStudentProjectFunctionality(
    props.actions.project_id,
  );
  if (studentProjectFunctionality.disableActions) {
    return <div></div>;
  }
  return <ActionBarEnabled {...props} />;
}

function ActionBarEnabled({
  project_id,
  checked_files,
  listing,
  current_path,
  actions,
  refreshBackups,
  hasPendingUpdate,
  onRefreshListing,
  autoUpdateListing,
  onToggleAutoUpdate,
  suppressPendingRefresh = false,
  readOnly = false,
  allowCopyOut = false,
}: Props) {
  const intl = useIntl();
  const currentParts = current_path.split("/").filter(Boolean);
  const inBackups = isBackupsPath(current_path);

  const [backupsMeta, setBackupsMeta] = useState<BackupMeta[] | null>(null);
  const [backupsLoading, setBackupsLoading] = useState<boolean>(false);
  const [backupsErr, setBackupsErr] = useState<any>(null);
  const [backupsTick, setBackupsTick] = useState(0);
  const backupsRequestIdRef = useRef(0);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const selectedOpenablePaths = useMemo(() => {
    const listingByPath = new Map(
      listing.map((file) => [misc.path_to_file(current_path, file.name), file]),
    );
    return checked_files
      .toArray()
      .filter((file) => !listingByPath.get(file)?.isDir);
  }, [checked_files, current_path, listing]);
  const openSelectedMenuItems = useMemo((): MenuItems => {
    if (checked_files.size === 0) return [];
    return [
      {
        disabled: selectedOpenablePaths.length === 0,
        key: "open-selected",
        label: (
          <span style={{ whiteSpace: "nowrap" }}>
            <Icon name="edit-filled" style={{ marginRight: 6 }} />
            Open
          </span>
        ),
        onClick: () => {
          for (const file of selectedOpenablePaths) {
            actions.open_file({
              explicit: true,
              foreground: false,
              path: file,
            });
          }
        },
      },
    ];
  }, [actions, checked_files.size, selectedOpenablePaths]);

  useEffect(() => {
    const requestId = backupsRequestIdRef.current + 1;
    backupsRequestIdRef.current = requestId;
    if (!inBackups || !project_id) {
      setBackupsMeta(null);
      setBackupsErr(null);
      setBackupsLoading(false);
      return;
    }
    (async () => {
      try {
        setBackupsLoading(true);
        setBackupsErr(null);
        const backups = await getBackups({
          project_id,
          indexed_only: true,
        });
        if (backupsRequestIdRef.current !== requestId) return;
        setBackupsMeta(
          backups.map(({ id, time }) => ({
            id,
            name: new Date(time).toISOString(),
            mtime: new Date(time).getTime(),
          })),
        );
      } catch (err) {
        if (backupsRequestIdRef.current !== requestId) return;
        setBackupsErr(err);
      } finally {
        if (backupsRequestIdRef.current !== requestId) return;
        setBackupsLoading(false);
      }
    })();
  }, [inBackups, project_id, current_path, backupsTick]);

  interface BackupSelection {
    id: string;
    name: string;
    paths: string[];
  }

  async function performRestore() {
    if (!project_id) return;
    const entries = (backupContext as any).entries as BackupSelection[];
    if (!entries || entries.length === 0) return;
    try {
      setRestoreLoading(true);
      setRestoreError(null);
      for (const entry of entries) {
        for (const rel of entry.paths) {
          const dest =
            restoreMode === "tmp"
              ? path.posix.join("/tmp", rel || "")
              : undefined;
          const op =
            await webapp_client.conat_client.hub.projects.restoreBackup({
              project_id,
              id: entry.id,
              path: rel || undefined,
              dest,
            });
          actions?.trackRestoreOp?.(op);
        }
      }
      message.success("Restore started");
      actions?.open_directory?.(current_path, false);
      setRestoreOpen(false);
    } catch (err) {
      setRestoreError(err);
    } finally {
      setRestoreLoading(false);
    }
  }

  const backupContext = useMemo(() => {
    if (!inBackups) return { mode: "none" as const, entries: [] as any[] };
    if (backupsLoading)
      return { mode: "loading" as const, entries: [] as BackupSelection[] };
    if (backupsErr)
      return { mode: "error" as const, entries: [], err: backupsErr };
    if (!backupsMeta)
      return { mode: "loading" as const, entries: [] as BackupSelection[] };
    if (currentParts.length === 0 || currentParts[0] !== BACKUPS) {
      return { mode: "none" as const, entries: [] as BackupSelection[] };
    }

    const findBackup = (name: string) =>
      backupsMeta.find(
        (b) => b.name === name || b.id === name || b.id.startsWith(name),
      );

    if (currentParts.length === 1) {
      const names = Array.from(checked_files)
        .filter((p) => p.startsWith(`${BACKUPS}/`))
        .map((p) => p.slice(BACKUPS.length + 1).split("/")[0])
        .filter(Boolean);
      const entries: BackupSelection[] = [];
      for (const name of new Set(names)) {
        const backup = findBackup(name);
        if (backup) {
          entries.push({ id: backup.id, name: backup.name, paths: [""] });
        }
      }
      return { mode: "root" as const, entries };
    }

    const backupName = currentParts[1];
    const backup = findBackup(backupName);
    if (!backup) {
      return {
        mode: "error" as const,
        entries: [],
        err: new Error(`backup '${backupName}' not found`),
      };
    }
    const subpath = currentParts.slice(2).join("/");
    const startsWithCurrentPath = (candidate: string): boolean => {
      if (candidate === current_path) return true;
      if (current_path === "/") return candidate.startsWith("/");
      return candidate.startsWith(`${current_path}/`);
    };
    const relativeToCurrentPath = (candidate: string): string => {
      if (candidate === current_path) {
        return "";
      }
      if (current_path === "/") {
        return candidate.replace(/^\/+/, "");
      }
      return candidate.slice(current_path.length + 1).replace(/^\/+/, "");
    };
    const selected = Array.from(checked_files)
      .filter(startsWithCurrentPath)
      .map(relativeToCurrentPath)
      .filter(Boolean);
    const paths =
      selected.length === 0
        ? [subpath]
        : selected.map((name) =>
            subpath ? path.posix.join(subpath, name) : name,
          );
    return {
      mode: "inside" as const,
      entries: [{ id: backup.id, name: backup.name, paths }],
    };
  }, [
    inBackups,
    backupsLoading,
    backupsErr,
    backupsMeta,
    currentParts,
    checked_files,
    current_path,
  ]);

  const [restoreOpen, setRestoreOpen] = useState<boolean>(false);
  const [restoreMode, setRestoreMode] = useState<"same" | "tmp">("same");
  const [restoreLoading, setRestoreLoading] = useState<boolean>(false);
  const [restoreError, setRestoreError] = useState<any>(null);

  function render_currently_selected(): React.JSX.Element | undefined {
    const refreshButton =
      hasPendingUpdate && !suppressPendingRefresh ? (
        <RefreshButton onClick={onRefreshListing} />
      ) : null;
    if (listing.length === 0) {
      return readOnly && refreshButton ? (
        <div style={ROW_INFO_STYLE}>
          <FormattedMessage
            id="project.explorer.action-bar.read_only.empty"
            defaultMessage="Read-only listing."
          />{" "}
          {refreshButton}
        </div>
      ) : undefined;
    }
    const checked = checked_files.size;
    const total = listing.length;
    const style = ROW_INFO_STYLE;
    const autoUpdateButton =
      autoUpdateListing && onToggleAutoUpdate != null ? (
        <AutoUpdateButton
          checked={autoUpdateListing}
          onChange={onToggleAutoUpdate}
        />
      ) : null;

    if (checked === 0) {
      if (!readOnly && autoUpdateButton == null && refreshButton == null) {
        return;
      }
      return (
        <div style={style}>
          {readOnly ? (
            <FormattedMessage
              id="project.explorer.action-bar.read_only.info"
              defaultMessage="Viewer access is read-only. Select files to copy them to another project."
            />
          ) : null}
          {refreshButton}
          {autoUpdateButton && refreshButton ? <> &middot; </> : null}
          {autoUpdateButton}
        </div>
      );
    } else {
      return (
        <div style={style}>
          <span>
            {intl.formatMessage(
              {
                id: "project.explorer.action-bar.currently_selected.items",
                defaultMessage: "{checked} of {total} {items} selected",
              },
              {
                checked,
                total,
                items: intl.formatMessage(labels.item_plural, { total }),
              },
            )}
          </span>
          {refreshButton && <> &middot; {refreshButton}</>}
          {autoUpdateButton && <> &middot; {autoUpdateButton}</>}
        </div>
      );
    }
  }

  const backupEntries = (backupContext as any).entries as BackupSelection[];
  const restoreDisabled =
    !inBackups ||
    backupsLoading ||
    !backupEntries ||
    backupEntries.length === 0 ||
    backupContext.mode === "error";
  const deleteDisabled = !(
    inBackups &&
    currentParts.length === 1 &&
    backupEntries &&
    backupEntries.length > 0
  );

  async function deleteBackups() {
    if (!project_id) return;
    if (deleteDisabled) return;
    try {
      await runFreshAuthAction(async () => {
        for (const entry of backupEntries) {
          await webapp_client.conat_client.hub.projects.deleteBackup({
            browser_id: webapp_client.browser_id,
            project_id,
            id: entry.id,
          });
        }
        message.success("Backup deleted");
        // Force a refresh and clear selection so the listing updates immediately.
        actions?.set_all_files_unchecked?.();
        refreshBackups?.();
        setBackupsTick((value) => value + 1);
        actions?.open_directory?.(current_path, true);
      });
    } catch (err) {
      message.error(`${err}`);
    }
  }

  function renderRestoreModal() {
    if (!restoreOpen) return null;
    const paths =
      backupEntries?.flatMap((e) =>
        e.paths.map((p) => (p ? `${e.name}:${p}` : `${e.name} (all files)`)),
      ) ?? [];
    return (
      <Modal
        title={
          <>
            <Icon name="undo" /> Restore from backup
          </>
        }
        open={restoreOpen}
        onCancel={() => setRestoreOpen(false)}
        onOk={performRestore}
        confirmLoading={restoreLoading}
        okText="Restore"
      >
        <p>Select where to restore the selected files.</p>
        <Radio.Group
          value={restoreMode}
          onChange={(e) => setRestoreMode(e.target.value)}
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
        >
          <Radio value="same">Restore to original paths (overwrite)</Radio>
          <Radio value="tmp">Restore to /tmp/&lt;path&gt;</Radio>
        </Radio.Group>
        {paths && paths.length > 0 && (
          <ul style={{ marginTop: "10px" }}>
            {paths.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {restoreError && (
          <div
            style={{ color: "red", marginTop: "8px" }}
          >{`${restoreError}`}</div>
        )}
      </Modal>
    );
  }

  function render_backup_actions(): React.JSX.Element | undefined {
    if (checked_files.size === 0) {
      return;
    }
    return (
      <Space.Compact>
        <Button
          onClick={() => setRestoreOpen(true)}
          disabled={restoreDisabled}
          title={
            backupContext.mode === "error"
              ? `${backupContext.err}`
              : restoreDisabled
                ? "Select backup items to restore"
                : undefined
          }
        >
          <Icon name="undo" /> Restore
        </Button>
        <Button
          disabled={deleteDisabled}
          onClick={() => {
            if (deleteDisabled) return;
            const names =
              backupEntries
                ?.map((e) => e.name)
                .filter(Boolean)
                .sort() ?? [];
            Modal.confirm({
              title: "Delete selected backups?",
              content:
                names.length > 0 ? (
                  <div>
                    <p>This will permanently remove:</p>
                    <ul style={{ paddingLeft: "20px" }}>
                      {names.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  </div>
                ) : null,
              okText: "Delete",
              cancelText: "Cancel",
              onOk: deleteBackups,
            });
          }}
        >
          <Icon name="trash" /> Delete
        </Button>
        {renderRestoreModal()}
      </Space.Compact>
    );
  }

  function render_action_buttons(): React.JSX.Element | undefined {
    if (readOnly && !allowCopyOut) {
      return;
    }
    if (inBackups) {
      return render_backup_actions();
    }
    let action_buttons: (
      | "download"
      | "compress"
      | "delete"
      | "rename"
      | "duplicate"
      | "move"
      | "copy"
    )[];
    if (checked_files.size === 0) {
      return;
    } else if (readOnly) {
      action_buttons = ["copy"];
    } else if (checked_files.size === 1) {
      let isDir;
      const item = checked_files.first();
      for (const file of listing) {
        if (misc.path_to_file(current_path, file.name) === item) {
          ({ isDir } = file);
        }
      }

      if (isDir) {
        // one directory selected
        action_buttons = [...ACTION_BUTTONS_DIR];
      } else {
        // one file selected
        action_buttons = [...ACTION_BUTTONS_FILE];
      }
    } else {
      // multiple items selected
      action_buttons = [...ACTION_BUTTONS_MULTI];
    }
    return (
      <FileActionsDropdown
        names={action_buttons}
        current_path={current_path}
        actions={actions}
        extraItems={openSelectedMenuItems}
        selectedPaths={checked_files.toArray()}
        label="Actions"
        showEllipsis={false}
        showDown={false}
      />
    );
  }

  function render_button_area(): React.JSX.Element | undefined {
    if (checked_files.size === 0) {
      return;
    } else {
      return render_action_buttons();
    }
  }
  if (checked_files.size === 0 && IS_MOBILE) {
    return null;
  }
  const buttonArea = render_button_area();
  const selectedInfo = render_currently_selected();
  if (buttonArea == null && selectedInfo == null) {
    return null;
  }
  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        flex: "1 0 auto",
        flexWrap: "wrap",
        gap: "8px",
        height: "32px",
      }}
    >
      {buttonArea != null ? (
        <div style={{ flex: "0 0 auto", whiteSpace: "nowrap", padding: 0 }}>
          {buttonArea}
        </div>
      ) : null}
      {selectedInfo != null ? (
        <div style={{ flex: "0 1 auto", minWidth: 0 }}>{selectedInfo}</div>
      ) : null}
      <FreshAuthModal {...freshAuthModalProps} />
    </div>
  );
}
