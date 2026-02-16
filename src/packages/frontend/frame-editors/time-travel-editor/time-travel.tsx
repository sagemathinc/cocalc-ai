/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Time travel editor react component

import { Button, Modal, Radio, Select, Space, Tooltip, message } from "antd";
import { Map, List } from "immutable";
import { debounce } from "lodash";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { AccountState } from "@cocalc/frontend/account/types";
import {
  useAsyncEffect,
  useEditorRedux,
} from "@cocalc/frontend/app-framework";
import { Loading, TimeAgo } from "@cocalc/frontend/components";
import ShowError from "@cocalc/frontend/components/error";
import { lite } from "@cocalc/frontend/lite";
import type { Document } from "@cocalc/sync/editor/generic/types";
import json_stable from "json-stable-stringify";
import { to_ipynb } from "../../jupyter/history-viewer";
import { TimeTravelActions, TimeTravelState } from "./actions";
import { GitAuthors, TimeTravelAuthors } from "./authors";
import { Diff } from "./diff";
import { LoadMoreHistory } from "./load-more-history";
import { LogView } from "./log-view";
import { NavigationButtons } from "./navigation-buttons";
import { NavigationSlider } from "./navigation-slider";
import { OpenFile } from "./open-file";
import { OpenSnapshots } from "./open-snapshots";
import { RangeSlider } from "./range-slider";
import { RevertFile } from "./revert-file";
import { Version, VersionRange } from "./version";
import { HAS_SPECIAL_VIEWER, Viewer } from "./viewer";

interface Props {
  actions: TimeTravelActions;
  id: string;
  path: string;
  project_id: string;
  desc: Map<string, any>;
  font_size: number;
  editor_settings: AccountState["editor_settings"];
  resize: number;
  is_current: boolean;
  is_subframe: boolean;
}

export function TimeTravel(props: Props) {
  const { project_id, path } = props;

  const useEditor = useEditorRedux<TimeTravelState>({ project_id, path });
  const error = useEditor("error");
  const versions =
    (useEditor("versions") as List<string | number> | undefined) ??
    List<string | number>();
  const firstVersion = useEditor("first_version") ?? 0;
  const gitVersions =
    (useEditor("git_versions") as List<number> | undefined) ?? List<number>();
  const snapshotVersions =
    (useEditor("snapshot_versions") as List<string> | undefined) ??
    List<string>();
  const backupVersions =
    (useEditor("backup_versions") as List<string> | undefined) ??
    List<string>();
  const hasFullHistory = useEditor("has_full_history");
  const loading = useEditor("loading");
  const docpath = useEditor("docpath");
  const docext = useEditor("docext");
  const git = !!useEditor("git");

  const [doc, setDoc] = useState<(() => Document | undefined) | undefined>(
    undefined,
  );
  const [doc0, setDoc0] = useState<string | undefined>(undefined);
  const [doc1, setDoc1] = useState<string | undefined>(undefined);
  const [useJson, setUseJson] = useState<boolean>(false);

  const [marks, setMarks] = useState<boolean>(!!props.desc?.get("marks"));
  const [source, setSource] = useState<
    "timetravel" | "git" | "snapshots" | "backups"
  >(() => {
    const s = props.desc?.get("source");
    if (s === "git" || s === "timetravel" || s === "snapshots" || s === "backups") {
      return s;
    }
    if (props.desc?.get("gitMode")) {
      return "git";
    }
    if (props.desc?.get("snapshotsMode")) {
      return "snapshots";
    }
    return "timetravel";
  });
  const [textMode, setTextMode] = useState<boolean>(
    !!props.desc?.get("textMode"),
  );
  const [changesMode, setChangesMode] = useState<boolean>(
    !!props.desc?.get("changesMode"),
  );
  const [showCommitRange, setShowCommitRange] = useState<boolean>(false);
  const [showChangedFiles, setShowChangedFiles] = useState<boolean>(false);
  const [logMode, setLogMode] = useState<boolean>(() => {
    const saved = props.desc?.get("logMode");
    return saved == null ? true : !!saved;
  });
  const [metaTitleHover, setMetaTitleHover] = useState<boolean>(false);
  const [logCompareHintShown, setLogCompareHintShown] =
    useState<boolean>(false);
  const [gitChangedFiles, setGitChangedFiles] = useState<string[]>([]);
  const [version, setVersion] = useState<number | string | undefined>(
    props.desc?.get("version"),
  );
  const [version0, setVersion0] = useState<number | string | undefined>(
    props.desc?.get("version0"),
  );
  const [version1, setVersion1] = useState<number | string | undefined>(
    props.desc?.get("version1"),
  );
  const gitMode = source === "git";
  const snapshotsMode = source === "snapshots";
  const backupsMode = source === "backups";
  const activeVersions = useMemo(
    () =>
      gitMode
        ? gitVersions
        : backupsMode
          ? backupVersions
          : snapshotsMode
          ? snapshotVersions
          : versions,
    [
      gitMode,
      snapshotsMode,
      backupsMode,
      gitVersions,
      snapshotVersions,
      backupVersions,
      versions,
    ],
  );

  const versionToNumber = (
    v: string | number | undefined,
  ): number | undefined => {
    if (v == null) return undefined;
    if (typeof v === "number") return v;
    if (backupsMode) {
      return props.actions.backupWallTime(v) ?? undefined;
    }
    if (snapshotsMode) {
      return props.actions.snapshotWallTime(v) ?? undefined;
    }
    return props.actions.patchTime(v) ?? undefined;
  };

  // ensure version consistency
  useEffect(() => {
    const v = activeVersions;
    if (v == null || v.size == 0) {
      return;
    }
    if (changesMode) {
      let v0 = version0;
      let v1 = version1;
      if (v0 == null || v.indexOf(v0) == -1) {
        v0 = v.get(0);
      }
      if (v1 == null || v.indexOf(v1) == -1) {
        v1 = v.get(-1);
      }
      if (v0 == v1 && v.size > 1) {
        if (v0 == v.get(0)) {
          v1 = v.get(1);
        } else if (v1 == v.get(-1)) {
          v0 = v.get(-2);
        } else {
          v0 = v.get(v.indexOf(v1!) - 1);
        }
      }

      if (v0 != version0) {
        setVersion0(v0);
      }
      if (v1 != version1) {
        setVersion1(v1);
      }
    } else {
      if (version == null) {
        setVersion(v.get(-1));
      } else if (v.indexOf(version) == -1) {
        let a;
        const numVersion = versionToNumber(version);
        const firstNum = versionToNumber(v.get(0));
        const lastNum = versionToNumber(v.get(-1));
        if (numVersion != null && firstNum != null && numVersion < firstNum) {
          a = v.get(0);
        } else if (
          numVersion != null &&
          lastNum != null &&
          numVersion > lastNum
        ) {
          a = v.get(-1);
        } else {
          a = v.get(-1);
        }
        setVersion(a);
      }
    }
  }, [
    version,
    version0,
    version1,
    activeVersions,
    changesMode,
    source,
    marks,
    snapshotsMode,
    backupsMode,
  ]);

  useEffect(() => {
    if (error) {
      //clear error on version list change
      props.actions.set_error("");
    }
  }, [version, version0, version1, source, changesMode]);

  useAsyncEffect(async () => {
    if (gitMode) {
      await props.actions.updateGitVersions();
      return;
    }
    if (snapshotsMode) {
      await props.actions.updateSnapshotVersions();
      return;
    }
    if (backupsMode) {
      await props.actions.updateBackupVersions();
      return;
    }
  }, [props.actions, source]);

  const wallTime = useMemo(() => {
    return gitMode
      ? (version: number | string) => Number(version)
      : backupsMode
        ? (v: number | string) => props.actions.backupWallTime(v)
        : snapshotsMode
        ? (v: number | string) => props.actions.snapshotWallTime(v)
        : (v: number | string) => props.actions.wallTime(v as string);
  }, [gitMode, snapshotsMode, backupsMode, props.actions]);

  const toPatchId = (v?: number | string) =>
    v == null ? undefined : (`${v}` as string);

  const gitRangeCommits = useMemo(() => {
    if (!gitMode || !changesMode) return [];
    return props.actions.gitCommitRange(version0, version1);
  }, [props.actions, gitMode, changesMode, version0, version1]);

  useEffect(() => {
    saveState(props.actions, {
      id: props.id,
      version,
      version0,
      version1,
      changesMode,
      gitMode,
      source,
      snapshotsMode,
      backupsMode,
      textMode,
      marks,
      logMode,
    });
  }, [
    version,
    version0,
    version1,
    changesMode,
    gitMode,
    snapshotsMode,
    backupsMode,
    textMode,
    logMode,
    source,
  ]);

  const getDoc = async (
    version?: number | string,
  ): Promise<(() => Document | undefined) | undefined> => {
    if (version == null) {
      return;
    }
    if (gitMode) {
      const v = typeof version === "number" ? version : Number(`${version}`);
      const x = await props.actions.gitDoc(v);
      return () => x!;
    }
    if (snapshotsMode) {
      const x = await props.actions.snapshotDoc(version);
      return () => x!;
    }
    if (backupsMode) {
      const x = await props.actions.backupDoc(version);
      return () => x!;
    }
    if (typeof version == "number") {
      console.warn("getDoc: invalid version", { version });
      return;
    }
    return () => props.actions.get_doc(version);
  };

  useAsyncEffect(async () => {
    if (docpath == null) {
      return;
    }
    if (!changesMode) {
      // non-changes mode
      const f = await getDoc(version);
      // use a function since getDoc returns a function
      setDoc(() => f);
    } else {
      // diff mode
      const doc0 = (await getDoc(version0))?.();
      if (doc0 == null) return; // something is wrong
      const doc1 = (await getDoc(version1))?.();
      if (doc1 == null) return; // something is wrong

      let v0, v1;
      if (docext == "ipynb") {
        v0 = json_stable(to_ipynb(doc0), { space: 1 });
        v1 = json_stable(to_ipynb(doc1), { space: 1 });
        setUseJson(true);
      } else {
        v0 = doc0.to_str();
        v1 = doc1.to_str();
        setUseJson(doc0["value"] == null);
      }
      setDoc0(v0);
      setDoc1(v1);
    }
  }, [
    version,
    version0,
    version1,
    changesMode,
    source,
    activeVersions,
  ]);

  useAsyncEffect(async () => {
    if (!gitMode || changesMode || version == null) {
      setGitChangedFiles([]);
      return;
    }
    const files = await props.actions.gitChangedFiles(version);
    setGitChangedFiles(files);
  }, [props.actions, gitMode, changesMode, version]);

  const renderVersion = () => {
    const logTitleLink = (content: ReactNode) => (
      <span
        style={{
          cursor: "pointer",
          textDecoration: metaTitleHover ? "underline" : "none",
        }}
        onMouseEnter={() => setMetaTitleHover(true)}
        onMouseLeave={() => setMetaTitleHover(false)}
        onClick={() => setLogMode(true)}
      >
        {content}
      </span>
    );
    const v = activeVersions;
    if (v == null || v.size == 0) {
      return null;
    }
    if (changesMode) {
      if (gitMode) {
        const c0 = props.actions.gitCommit(version0);
        const c1 = props.actions.gitCommit(version1);
        if (c0 == null || c1 == null) return null;
        return (
          <span style={{ whiteSpace: "nowrap" }}>
            Commits <b>{c0.shortHash}</b> to <b>{c1.shortHash}</b>
          </span>
        );
      }
      if (snapshotsMode) {
        if (version0 == null || version1 == null) return null;
        const t0 = props.actions.snapshotWallTime(version0);
        const t1 = props.actions.snapshotWallTime(version1);
        const label0 =
          t0 == null ? `${version0}` : new Date(t0).toLocaleString();
        const label1 =
          t1 == null ? `${version1}` : new Date(t1).toLocaleString();
        return (
          <span style={{ whiteSpace: "nowrap" }}>
            Snapshots <b>{label0}</b> to <b>{label1}</b>
          </span>
        );
      }
      if (backupsMode) {
        if (version0 == null || version1 == null) return null;
        const t0 = props.actions.backupWallTime(version0);
        const t1 = props.actions.backupWallTime(version1);
        const label0 =
          t0 == null ? `${version0}` : new Date(t0).toLocaleString();
        const label1 =
          t1 == null ? `${version1}` : new Date(t1).toLocaleString();
        return (
          <span style={{ whiteSpace: "nowrap" }}>
            Backups <b>{label0}</b> to <b>{label1}</b>
          </span>
        );
      }
      if (version0 == null || version1 == null) {
        return null;
      }
      const i0 = v.indexOf(version0);
      if (i0 == -1) {
        return null;
      }
      const i1 = v.indexOf(version1);
      if (i1 == -1) {
        return null;
      }
      const id0 = toPatchId(version0);
      const id1 = toPatchId(version1);
      if (id0 == null || id1 == null) return null;
      return (
        <VersionRange
          version0={props.actions.versionNumber(id0) ?? i0 + firstVersion}
          user0={props.actions.getUser(id0)}
          version1={props.actions.versionNumber(id1) ?? i1 + firstVersion}
          user1={props.actions.getUser(id1)}
        />
      );
    } else {
      if (version == null) {
        return null;
      }
      if (gitMode) {
        const commit = props.actions.gitCommit(version);
        if (commit == null) return null;
        return (
          <span style={{ whiteSpace: "nowrap" }}>
            {logTitleLink(<b>{commit.subject}</b>)} ·{" "}
            <Button
              type="link"
              size="small"
              style={{ padding: 0, height: "auto" }}
              onClick={() => void copyHash(commit.hash)}
            >
              {commit.shortHash}
            </Button>{" "}
            ·{" "}
            {commit.authorName} ·{" "}
            <TimeAgo
              date={new Date(commit.timestampMs)}
              time_ago_absolute
            />
          </span>
        );
      }
      if (snapshotsMode) {
        const t = props.actions.snapshotWallTime(version);
        return (
          <span style={{ whiteSpace: "nowrap" }}>
            {logTitleLink(
              <>
                Snapshot <b>{`${version}`}</b>
              </>,
            )}
            {t != null && (
              <>
                {" "}·{" "}
                <TimeAgo date={new Date(t)} time_ago_absolute />
              </>
            )}
          </span>
        );
      }
      if (backupsMode) {
        const t = props.actions.backupWallTime(version);
        return (
          <span style={{ whiteSpace: "nowrap" }}>
            {logTitleLink(
              <>
                Backup <b>{`${version}`.slice(0, 8)}</b>
              </>,
            )}
            {t != null && (
              <>
                {" "}·{" "}
                <TimeAgo date={new Date(t)} time_ago_absolute />
              </>
            )}
          </span>
        );
      }
      const i = v.indexOf(version);
      if (i == -1) {
        return null;
      }
      const id = toPatchId(version);
      if (id == null) return null;
      const t = props.actions.wallTime(id);
      if (t == null) {
        return null;
      }
      return logTitleLink(
        <Version
          date={new Date(t)}
          number={props.actions.versionNumber(id) ?? i + firstVersion}
          user={props.actions.getUser(id)}
        />,
      );
    }
  };

  const getSelectedVersionMeta = (
    selected: string | number | undefined,
  ): {
    title: ReactNode;
    subtitle?: ReactNode;
    timeMs?: number;
  } | null => {
    if (selected == null) return null;
    if (gitMode) {
      const commit = props.actions.gitCommit(selected);
      if (commit == null) return null;
      return {
        title: (
          <span
            style={{ cursor: "pointer", textDecoration: "underline" }}
            onClick={() => setLogMode(true)}
          >
            {commit.subject}
          </span>
        ),
        subtitle: (
          <>
            <Button
              type="link"
              size="small"
              style={{ padding: 0, height: "auto" }}
              onClick={() => void copyHash(commit.hash)}
            >
              {commit.shortHash}
            </Button>{" "}
            · {commit.authorName}
          </>
        ),
        timeMs: commit.timestampMs,
      };
    }
    if (snapshotsMode) {
      const t = props.actions.snapshotWallTime(selected);
      return {
        title: (
          <span
            style={{ cursor: "pointer", textDecoration: "underline" }}
            onClick={() => setLogMode(true)}
          >
            Snapshot {`${selected}`}
          </span>
        ),
        timeMs: t,
      };
    }
    if (backupsMode) {
      const t = props.actions.backupWallTime(selected);
      const id = `${selected}`;
      return {
        title: (
          <span
            style={{ cursor: "pointer", textDecoration: "underline" }}
            onClick={() => setLogMode(true)}
          >
            Backup {id.slice(0, 8)}
          </span>
        ),
        subtitle: id,
        timeMs: t,
      };
    }
    const id = `${selected}`;
    const i = activeVersions.indexOf(selected);
    const number = props.actions.versionNumber(id) ?? i + firstVersion;
    const t = props.actions.wallTime(id);
    const user = props.actions.getUser(id);
    return {
      title: (
        <span
          style={{ cursor: "pointer", textDecoration: "underline" }}
          onClick={() => setLogMode(true)}
        >
          Revision {number}
          {toLetterCode(user)}
        </span>
      ),
      timeMs: t ?? undefined,
    };
  };

  const canStepRangeEdge = (
    edge: "start" | "end",
    delta: -1 | 1,
  ): boolean => {
    if (!changesMode) return false;
    const selected = edge === "start" ? version0 : version1;
    const other = edge === "start" ? version1 : version0;
    if (selected == null || other == null) return false;
    const i = activeVersions.indexOf(selected);
    const j = activeVersions.indexOf(other);
    if (i === -1 || j === -1) return false;
    const target = i + delta;
    if (target < 0 || target >= activeVersions.size) return false;
    if (edge === "start") return target < j;
    return target > j;
  };

  const stepRangeEdge = (edge: "start" | "end", delta: -1 | 1): void => {
    if (!canStepRangeEdge(edge, delta)) return;
    const selected = edge === "start" ? version0 : version1;
    if (selected == null) return;
    const i = activeVersions.indexOf(selected);
    if (i === -1) return;
    const next = activeVersions.get(i + delta);
    if (next == null) return;
    if (edge === "start") {
      setVersion0(next);
    } else {
      setVersion1(next);
    }
  };

  const renderChangesSelectionRows = () => {
    if (logMode || !changesMode || version0 == null || version1 == null) {
      return null;
    }
    const start = getSelectedVersionMeta(version0);
    const end = getSelectedVersionMeta(version1);
    const renderRow = (
      label: string,
      meta: { title: ReactNode; subtitle?: ReactNode; timeMs?: number } | null,
      edge: "start" | "end",
    ) => (
      <div
        style={{
          border: "1px solid #e6e6e6",
          borderRadius: "6px",
          padding: "6px 8px",
          minWidth: "320px",
          flex: "1 1 320px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "4px",
          }}
        >
          <b>{label}</b>
          <Space.Compact>
            <Button
              size="small"
              disabled={!canStepRangeEdge(edge, -1)}
              onClick={() => stepRangeEdge(edge, -1)}
            >
              ◀
            </Button>
            <Button
              size="small"
              disabled={!canStepRangeEdge(edge, 1)}
              onClick={() => stepRangeEdge(edge, 1)}
            >
              ▶
            </Button>
          </Space.Compact>
        </div>
        {meta == null ? (
          <div style={{ color: "#666", fontSize: "12px" }}>Unknown version</div>
        ) : (
          <>
            <div style={{ fontWeight: 600 }}>{meta.title}</div>
            <div style={{ color: "#666", fontSize: "12px" }}>
              {meta.subtitle ?? ""}
              {meta.timeMs != null && (
                <>
                  {meta.subtitle ? " · " : ""}
                  <TimeAgo date={new Date(meta.timeMs)} time_ago_absolute />
                </>
              )}
            </div>
          </>
        )}
      </div>
    );
    return (
      <div
        style={{
          marginTop: "6px",
          display: "flex",
          gap: "8px",
          flexWrap: "wrap",
        }}
      >
        {renderRow("From", start, "start")}
        {renderRow("To", end, "end")}
      </div>
    );
  };

  const renderDiff = () => {
    if (!changesMode) {
      return;
    }
    if (doc0 == null || doc1 == null) {
      return renderLoading();
    }

    return (
      <Diff
        v0={doc0}
        v1={doc1}
        path={docpath}
        font_size={props.font_size}
        editor_settings={props.editor_settings}
        use_json={useJson}
      />
    );
  };

  const renderNavigationButtons = () => {
    if (logMode) {
      return;
    }
    if (changesMode && (version0 == null || version1 == null)) {
      return;
    }
    return (
      <NavigationButtons
        changesMode={changesMode}
        versions={activeVersions}
        version={version}
        setVersion={setVersion}
        version0={version0}
        setVersion0={setVersion0}
        version1={version1}
        setVersion1={setVersion1}
      />
    );
  };

  const renderNavigationSlider = () => {
    if (logMode) {
      return;
    }
    if (changesMode) {
      return;
    }
    return (
      <NavigationSlider
        version={version}
        setVersion={setVersion}
        versions={activeVersions}
        marks={marks}
        wallTime={wallTime}
      />
    );
  };

  const renderRangeSlider = () => {
    if (logMode) {
      return;
    }
    if (!changesMode) {
      return;
    }
    return (
      <RangeSlider
        versions={activeVersions}
        version0={version0}
        setVersion0={setVersion0}
        version1={version1}
        setVersion1={setVersion1}
        wallTime={wallTime}
        marks={marks}
      />
    );
  };

  const renderAuthor = () => {
    if (changesMode && (version0 == null || version1 == null)) {
      return;
    }
    if (!changesMode && version == null) {
      return;
    }
    if ((gitMode || snapshotsMode || backupsMode) && !changesMode) {
      return null;
    }
    const opts = changesMode
      ? { actions: props.actions, version0, version1 }
      : { actions: props.actions, version0: version, version1: version };
    if (gitMode) {
      return <GitAuthors {...opts} />;
    } else if (snapshotsMode || backupsMode) {
      return null;
    } else {
      return <TimeTravelAuthors {...opts} />;
    }
  };

  const renderLoadMoreHistory = () => {
    if (gitMode || snapshotsMode || backupsMode) {
      return;
    }
    return (
      <LoadMoreHistory
        actions={props.actions}
        hasFullHistory={hasFullHistory}
      />
    );
  };

  const renderOpenFile = () => {
    if (props.is_subframe) return;
    return <OpenFile actions={props.actions} />;
  };

  const renderOpenSnapshots = () => {
    if (props.is_subframe) return;
    return <OpenSnapshots actions={props.actions} />;
  };

  const renderRevertFile = () => {
    if (doc == null || changesMode || logMode) {
      return;
    }
    return (
      <RevertFile
        gitMode={gitMode || snapshotsMode || backupsMode}
        actions={props.actions}
        version={version}
        doc={doc}
      />
    );
  };

  const renderChangesMode = () => {
    if (logMode) {
      return null;
    }
    const size = activeVersions?.size ?? 0;
    return (
      <Select
        size="small"
        style={{ width: 170 }}
        value={changesMode ? "compare" : "single"}
        onChange={(value) => setChangesMode(value === "compare")}
        options={[
          { value: "single", label: "Single Version" },
          { value: "compare", label: "Compare Changes", disabled: size <= 1 },
        ]}
      />
    );
  };

  const renderModeSelectors = () => {
    const showTextToggle = !changesMode && HAS_SPECIAL_VIEWER.has(docext ?? "");
    const sourceOptions = [
      { value: "timetravel", label: "TimeTravel" },
      { value: "git", label: "Git", disabled: !git },
      { value: "snapshots", label: "Snapshots", disabled: lite },
      { value: "backups", label: "Backups", disabled: lite },
    ];
    return (
      <>
        <Select
          size="small"
          style={{ width: 150 }}
          value={source}
          options={sourceOptions}
          onChange={(value) => {
            if (
              value === "timetravel" ||
              value === "git" ||
              value === "snapshots" ||
              value === "backups"
            ) {
              setVersion(undefined);
              setVersion0(undefined);
              setVersion1(undefined);
              setShowChangedFiles(false);
              setShowCommitRange(false);
              setSource(value);
            }
          }}
        />
        <Select
          size="small"
          style={{ width: 125 }}
          value={textMode ? "source" : "rendered"}
          disabled={!showTextToggle}
          options={[
            { value: "rendered", label: "Rendered" },
            { value: "source", label: "Source" },
          ]}
          onChange={(value) => setTextMode(value === "source")}
        />
        {renderChangesMode()}
        {!logMode && (
          <Select
            size="small"
            style={{ width: 155 }}
            value={marks ? "timestamp" : "revision"}
            options={[
              { value: "revision", label: "Slider: Revision #" },
              { value: "timestamp", label: "Slider: Timestamp" },
            ]}
            onChange={(value) => setMarks(value === "timestamp")}
          />
        )}
      </>
    );
  };

  const copyHash = async (hash: string) => {
    try {
      await navigator.clipboard.writeText(hash);
      message.success("Copied full commit hash");
    } catch (_err) {
      message.error("Unable to copy commit hash");
    }
  };

  const renderCommitsInRangeButton = () => {
    if (logMode || !gitMode || !changesMode) return null;
    return (
      <Button size="small" onClick={() => setShowCommitRange(true)}>
        Show Commits In Range
      </Button>
    );
  };

  const renderCommitRangeModal = () => {
    if (!gitMode || !changesMode) return null;
    return (
      <Modal
        open={showCommitRange}
        title="Commits in selected range"
        onCancel={() => setShowCommitRange(false)}
        footer={null}
      >
        {gitRangeCommits.length === 0 ? (
          <div>No commits found for this range.</div>
        ) : (
          <div>
            {gitRangeCommits.map((commit) => (
              <div key={commit.hash} style={{ marginBottom: "8px" }}>
                <Button
                  type="link"
                  size="small"
                  style={{ padding: 0, marginRight: "6px" }}
                  onClick={() => void copyHash(commit.hash)}
                >
                  {commit.shortHash}
                </Button>
                <span>{commit.subject}</span>
                <div style={{ color: "#666", fontSize: "12px" }}>
                  {commit.authorName} ·{" "}
                  <TimeAgo
                    date={new Date(commit.timestampMs)}
                    time_ago_absolute
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>
    );
  };

  const renderGitChangedFilesButton = () => {
    if (!gitMode || changesMode || version == null || docpath == null) {
      return null;
    }
    const files = gitChangedFiles.filter((x) => x !== docpath);
    if (files.length === 0) {
      return null;
    }
    return (
      <Button
        size="small"
        onClick={() => setShowChangedFiles(true)}
      >
        Also changed ({files.length})
      </Button>
    );
  };

  const renderGitChangedFilesModal = () => {
    if (!gitMode || changesMode || version == null || docpath == null) {
      return null;
    }
    const commit = props.actions.gitCommit(version);
    if (commit == null) {
      return null;
    }
    const files = gitChangedFiles.filter((x) => x !== docpath);
    return (
      <Modal
        open={showChangedFiles}
        title={`Also changed in ${commit.shortHash}`}
        onCancel={() => setShowChangedFiles(false)}
        footer={null}
      >
        <div style={{ maxHeight: "55vh", overflowY: "auto" }}>
          {files.length === 0 ? (
            <div>No additional files changed in this commit.</div>
          ) : (
            files.map((file) => (
              <div key={file} style={{ marginBottom: "6px" }}>
                <Button
                  type="link"
                  size="small"
                  style={{ padding: 0, height: "auto" }}
                  onClick={() =>
                    void props.actions.openGitCommitFile(file, commit.hash)
                  }
                >
                  {file}
                </Button>
              </div>
            ))
          )}
        </div>
      </Modal>
    );
  };

  const renderControls = () => {
    const activeVersionCount = activeVersions?.size ?? 0;
    return (
      <div
        style={{
          background: props.is_current ? "#fafafa" : "#ddd",
          borderBottom: "1px solid #ccc",
          padding: "5px",
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "6px",
          }}
        >
          <Radio.Group
            size="small"
            value={logMode ? "log" : "document"}
            onChange={(e) => setLogMode(e.target.value === "log")}
            optionType="button"
            buttonStyle="solid"
            options={[
              { label: "Log", value: "log" },
              { label: "File", value: "document" },
            ]}
          />
          <Space.Compact>{renderModeSelectors()}</Space.Compact>
          {renderCommitsInRangeButton()}
          {renderGitChangedFilesButton()}
          {(gitMode || snapshotsMode || backupsMode) && (
            <Tooltip
              title={
                gitMode
                  ? "Scan local Git repository for new revisions to this file"
                  : snapshotsMode
                    ? "Scan project snapshots for revisions of this file"
                    : "Scan project backups for revisions of this file"
              }
            >
              <Button
                size="small"
                onClick={() => {
                  if (gitMode) {
                    props.actions.updateGitVersions();
                  } else if (snapshotsMode) {
                    props.actions.updateSnapshotVersions();
                  } else if (backupsMode) {
                    props.actions.updateBackupVersions();
                  }
                }}
              >
                Refresh
              </Button>
            </Tooltip>
          )}
          {renderNavigationButtons()}
          <Space.Compact>
            {renderOpenFile()}
            {renderRevertFile()}
            {renderOpenSnapshots()}
          </Space.Compact>
        </div>
        {!logMode && activeVersionCount > 0 && (
          <div style={{ marginTop: "6px", fontSize: "12px", color: "#666" }}>
            {renderRevisionMeta()}
          </div>
        )}
        {renderChangesSelectionRows()}
      </div>
    );
  };

  const renderTimeSelect = () => {
    if (logMode) {
      return null;
    }
    return (
      <div style={{ display: "flex" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          {renderLoadMoreHistory()}
        </div>
        <div style={{ flex: 1 }}>
          {renderNavigationSlider()}
          {renderRangeSlider()}
        </div>
      </div>
    );
  };

  const renderLoading = () => {
    return <Loading theme={"medium"} />;
  };

  const renderRevisionMeta = () => {
    if (changesMode) return null;
    const versionMeta = renderVersion();
    const authorMeta = renderAuthor();
    if (versionMeta == null && authorMeta == null) return null;
    if (versionMeta == null) return authorMeta;
    if (authorMeta == null) return versionMeta;
    return (
      <>
        {versionMeta} · {authorMeta}
      </>
    );
  };

  if (loading) {
    return renderLoading();
  }

  let body;
  if (logMode) {
    body = (
      <LogView
        actions={props.actions}
        source={source}
        versions={activeVersions}
        currentVersion={version}
        firstVersion={firstVersion}
        onSelectVersion={(selected, opts) => {
          if (opts?.compareToPrevious) {
            const idx = activeVersions.indexOf(selected);
            if (idx > 0) {
              const older = activeVersions.get(idx - 1);
              if (older != null) {
                setVersion(selected);
                setVersion0(older);
                setVersion1(selected);
                setChangesMode(true);
                setLogMode(false);
                return;
              }
            }
            setVersion(selected);
            setChangesMode(false);
            setLogMode(false);
            message.info("No earlier version to compare against.");
            return;
          }
          if (opts?.open) {
            setVersion(selected);
            setChangesMode(false);
            setLogMode(false);
            return;
          }
          if (
            opts?.shiftKey &&
            version != null &&
            selected !== version &&
            activeVersions.indexOf(version) !== -1 &&
            activeVersions.indexOf(selected) !== -1
          ) {
            const i0 = activeVersions.indexOf(version);
            const i1 = activeVersions.indexOf(selected);
            const older = i0 <= i1 ? version : selected;
            const newer = i0 <= i1 ? selected : version;
            setVersion(older);
            setVersion0(older);
            setVersion1(newer);
            setChangesMode(true);
            setLogMode(false);
            if (!logCompareHintShown) {
              message.info(
                "Showing changes between selected versions (Shift+click from log).",
              );
              setLogCompareHintShown(true);
            }
            return;
          }
          setVersion(selected);
        }}
      />
    );
  } else if (doc != null && docpath != null && docext != null && !changesMode) {
    body = (
      <Viewer
        ext={docext}
        doc={doc}
        textMode={textMode}
        actions={props.actions}
        id={props.id}
        path={docpath ? docpath : "a.js"}
        project_id={props.project_id}
        font_size={props.font_size}
        editor_settings={props.editor_settings}
      />
    );
  } else {
    body = renderDiff();
  }

  return (
    <div className="smc-vfill">
      {renderControls()}
      {renderCommitRangeModal()}
      {renderGitChangedFilesModal()}
      {renderTimeSelect()}
      <ShowError
        style={{ margin: "5px 15px" }}
        error={error}
        setError={props.actions.set_error}
      />
      {body}
    </div>
  );
}

function toLetterCode(user?: number): string {
  if (user == null) return "";
  return String.fromCharCode(97 + (user % 26));
}

const saveState = debounce((actions, obj) => {
  for (const a of [actions, actions.ambient_actions]) {
    if (a == null) continue;
    const node = a._get_frame_node(obj.id);
    if (node == null) continue;
    a.set_frame_tree(obj);
  }
}, 2000);
