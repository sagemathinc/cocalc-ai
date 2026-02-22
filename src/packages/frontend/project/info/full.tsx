/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// cspell:ignore Questionmark

declare let DEBUG;

import { Alert, Button, Card, Form, Modal, Popover, Table, Tooltip } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";

import {
  InfoCircleOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  ScheduleOutlined,
} from "@ant-design/icons";
import { Col, Row } from "@cocalc/frontend/antd-bootstrap";
import { CSS, ProjectActions } from "@cocalc/frontend/app-framework";
import { A, Icon, Loading, Tip } from "@cocalc/frontend/components";
import { SiteName } from "@cocalc/frontend/customize";
import { labels } from "@cocalc/frontend/i18n";
import { cmp, field_cmp, seconds2hms } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import {
  Process,
  Processes,
  ProjectInfo as ProjectInfoType,
} from "@cocalc/util/types/project-info/types";
import type { ProjectInfoHistory } from "@cocalc/conat/project/project-info";
import { useProjectContext } from "../context";
import { ROOT_STYLE } from "../servers/consts";
import {
  AboutContent,
  CGroup,
  LabelQuestionmark,
  ProcState,
  ProjectProblems,
  SignalButtons,
} from "./components";
import { CGroupInfo, DUState, PTStats, ProcessRow } from "./types";
import {
  DETAILS_BTN_TEXT,
  SSH_KEYS_DOC,
  process_inclusive_value,
} from "./utils";

interface Props {
  any_alerts: () => boolean;
  cg_info: CGroupInfo;
  render_disconnected: () => React.JSX.Element | undefined;
  disconnected: boolean;
  disk_usage: DUState;
  error: React.JSX.Element | null;
  status: string;
  info: ProjectInfoType | null;
  history: ProjectInfoHistory | null;
  refresh: () => Promise<void>;
  loading: boolean;
  modal: string | Process | undefined;
  project_actions: ProjectActions | undefined;
  project_id: string;
  project_state: string | undefined;
  project_status: Immutable.Map<string, any> | undefined;
  pt_stats: PTStats;
  ptree: ProcessRow[] | undefined;
  select_proc: (pids: number[]) => void;
  selected: number[];
  set_expanded: (keys: number[]) => void;
  set_modal: (proc: string | Process | undefined) => void;
  set_selected: (pids: number[]) => void;
  show_explanation: boolean;
  show_long_loading: boolean;
  start_ts: number | undefined;
  render_cocalc: (proc: ProcessRow) => React.JSX.Element | undefined;
  onCellProps;
}

function sparklinePoints(values: number[], width = 240, height = 56): string {
  if (values.length === 0) return "";
  if (values.length === 1) {
    return `0,${height / 2} ${width},${height / 2}`;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const y = (value: number) => {
    if (max === min) return height / 2;
    return height - ((value - min) / (max - min)) * (height - 4) - 2;
  };
  const dx = width / (values.length - 1);
  return values.map((v, i) => `${(i * dx).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
}

function HistoryCard({
  title,
  values,
  unit,
  color,
}: {
  title: string;
  values: number[];
  unit: string;
  color: string;
}) {
  if (values.length === 0) return null;
  const latest = values[values.length - 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const points = sparklinePoints(values);
  return (
    <Card
      size="small"
      title={title}
      style={{ marginBottom: "8px" }}
      extra={
        <span style={{ color: COLORS.GRAY_D }}>
          now <b>{latest.toFixed(1)}</b> {unit}
        </span>
      }
    >
      <svg width="100%" height="64" viewBox="0 0 240 56" preserveAspectRatio="none">
        <polyline
          fill="none"
          stroke={color}
          strokeWidth="2"
          points={points}
          strokeLinecap="round"
        />
      </svg>
      <div style={{ color: COLORS.GRAY_D, fontSize: "85%" }}>
        range: {min.toFixed(1)} to {max.toFixed(1)} {unit}
      </div>
    </Card>
  );
}

function MiniTrend({
  values,
  timestamps,
  color,
  unit,
  label,
}: {
  values: number[];
  timestamps: number[];
  color: string;
  unit: string;
  label: string;
}): React.JSX.Element | null {
  const filtered: Array<{ value: number; timestamp: number }> = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const timestamp = timestamps[i];
    if (Number.isFinite(value) && Number.isFinite(timestamp)) {
      filtered.push({ value, timestamp });
    }
  }
  if (filtered.length < 2) {
    return null;
  }
  const trendValues = filtered.map(({ value }) => value);
  const trendTimestamps = filtered.map(({ timestamp }) => timestamp);
  const latest = trendValues[trendValues.length - 1];
  const min = Math.min(...trendValues);
  const max = Math.max(...trendValues);
  const startTs = trendTimestamps[0];
  const endTs = trendTimestamps[trendTimestamps.length - 1];
  const coveredMinutes = Math.max(0, (endTs - startTs) / (60 * 1000));
  const sampleSeconds =
    trendTimestamps.length > 1
      ? (endTs - startTs) / 1000 / (trendTimestamps.length - 1)
      : 0;
  const coveredLabel =
    coveredMinutes >= 1
      ? `${coveredMinutes.toFixed(1)} minutes`
      : `${Math.max(0, (endTs - startTs) / 1000).toFixed(0)} seconds`;

  const width = 64;
  const height = 16;
  const points = sparklinePoints(trendValues, width, height);
  const bigWidth = 280;
  const bigHeight = 88;
  const bigPoints = sparklinePoints(trendValues, bigWidth, bigHeight);
  const tooltip = (
    <div style={{ maxWidth: "300px" }}>
      <div>
        <strong>{label} history</strong>
      </div>
      <div>
        X-axis: oldest to newest visible sample for this process, covering{" "}
        {coveredLabel}.
      </div>
      <div>
        {trendValues.length} samples, about every {sampleSeconds.toFixed(0)}s.
      </div>
      <div>
        range: {min.toFixed(1)} to {max.toFixed(1)} {unit}; now{" "}
        {latest.toFixed(1)} {unit}.
      </div>
      <div style={{ marginTop: "8px" }}>
        <svg
          width="100%"
          height={bigHeight}
          viewBox={`0 0 ${bigWidth} ${bigHeight}`}
          preserveAspectRatio="none"
        >
          <polyline
            fill="none"
            stroke={color}
            strokeWidth="2"
            points={bigPoints}
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>
  );
  return (
    <Tooltip title={tooltip} placement="top">
      <span style={{ display: "inline-flex", cursor: "help" }}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          style={{ marginTop: "1px" }}
        >
          <polyline
            fill="none"
            stroke={color}
            strokeWidth="1.6"
            points={points}
            strokeLinecap="round"
          />
        </svg>
      </span>
    </Tooltip>
  );
}

export function Full(props: Readonly<Props>): React.JSX.Element {
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const projectLabelLower = projectLabel.toLowerCase();
  const {
    cg_info,
    render_disconnected,
    disconnected,
    disk_usage,
    error,
    status,
    info,
    history,
    refresh,
    loading,
    modal,
    project_actions,
    project_state,
    project_status,
    pt_stats,
    ptree,
    select_proc,
    selected,
    set_expanded,
    set_modal,
    set_selected,
    show_long_loading,
    start_ts,
    render_cocalc,
    onCellProps,
  } = props;

  const { contentSize } = useProjectContext();

  const problemsRef = useRef<HTMLDivElement>(null);
  const cgroupRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const generalStatusRef = useRef<HTMLDivElement>(null);
  const [tableHeight, setTableHeight] = useState<number>(400);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const historyByProcessId = useMemo(() => {
    const byId = new Map<string, { cpu: number[]; mem: number[]; timestamps: number[] }>();
    for (const sample of history?.samples ?? []) {
      for (const proc of Object.values(sample.processes ?? {})) {
        const cur = byId.get(proc.id) ?? { cpu: [], mem: [], timestamps: [] };
        cur.cpu.push(proc.cpu_pct);
        cur.mem.push(proc.mem_rss);
        cur.timestamps.push(sample.timestamp);
        byId.set(proc.id, cur);
      }
    }
    return byId;
  }, [history]);

  const inclusiveCmp = (field: "cpu_pct" | "cpu_tot" | "mem") => {
    return (a: ProcessRow, b: ProcessRow) =>
      cmp(process_inclusive_value(a, field), process_inclusive_value(b, field));
  };

  useEffect(() => {
    const calculateTableHeight = () => {
      const parentHeight = contentSize.height;
      if (parentHeight === 0) return; // Wait until contentSize is measured

      let usedHeight = 0;

      // Add height of ProjectProblems component
      usedHeight += problemsRef.current?.offsetHeight ?? 0;

      // Add height of CGroup component
      usedHeight += cgroupRef.current?.offsetHeight ?? 0;

      // Add height of header row
      usedHeight += headerRef.current?.offsetHeight ?? 0;

      // Add height of general status row if DEBUG is enabled
      if (DEBUG) {
        usedHeight += generalStatusRef.current?.offsetHeight ?? 0;
      }

      // Add more buffer for table header, margins, and other spacing
      usedHeight += 100;

      const availableHeight = Math.max(300, parentHeight - usedHeight);
      setTableHeight(availableHeight);
    };

    calculateTableHeight();

    // Recalculate on window resize
    window.addEventListener("resize", calculateTableHeight);
    return () => window.removeEventListener("resize", calculateTableHeight);
  }, [ptree, contentSize.height, contentSize.width]);

  function render_help_content() {
    const scopeDescription =
      info?.scope === "owned"
        ? "In this view, the process list includes processes that were started by this workspace (and their descendants)."
        : "In this view, the process list includes all visible processes in the workspace environment.";
    return (
      <div style={{ maxWidth: "560px" }}>
        <p>
          This panel shows <strong>real-time information about this project</strong>{" "}
          and its resource usage. In particular, you can see which processes are
          running, and if available, also get a button to <SiteName /> specific
          information or links to the associated file.
        </p>
        <p>
          {scopeDescription}
        </p>
        <p>
          Use the checkboxes on the left to select one or more processes (or use
          the header checkbox to select all visible rows). Then use{" "}
          "{DETAILS_BTN_TEXT}" for detailed process information, or send a
          signal to the selected process(es).
        </p>
        <p>
          Sub-processes are shown as a tree. When you collapse a branch, the
          values you see are the sum of that particular process and all its
          children. CPU and memory sorting use this inclusive value, so heavy
          process trees bubble up even if the parent itself is mostly idle.
          Small trend lines in CPU and Memory columns show per-process history
          when enough samples are available.
        </p>
        <p style={{ marginBottom: 0 }}>
          If there are any issues detected, there will be highlights in red.
          They could be caused by individual processes using CPU non-stop, the
          total of all processes hitting the overall memory limit, or even the
          disk space running low. You can often resolve these by interrupting,
          terminating, pausing, or resuming processes. If disk space is low, you
          must free space (or increase available disk quota in environments that
          support upgrades).
        </p>
      </div>
    );
  }

  function render_help() {
    return (
      <Form.Item>
        <Popover
          trigger={["click"]}
          placement="bottomRight"
          content={render_help_content()}
          title="Help"
          overlayStyle={{ maxWidth: "620px" }}
        >
          <Button
            type="text"
            size="small"
            icon={<QuestionCircleOutlined />}
            aria-label="Show help"
          />
        </Popover>
      </Form.Item>
    );
  }

  function render_history() {
    const samples = history?.samples ?? [];
    if (samples.length < 2) return;
    const cpu = samples.map((sample) => sample.project.cpu_pct);
    const mem = samples.map((sample) => sample.project.mem_rss);
    const startTs = samples[0].timestamp;
    const endTs = samples[samples.length - 1].timestamp;
    const coveredMinutes = Math.max(0, (endTs - startTs) / (60 * 1000));
    const sampleSeconds =
      samples.length > 1 ? (endTs - startTs) / 1000 / (samples.length - 1) : 0;
    const requestedMinutes = history?.minutes ?? coveredMinutes;
    const coveredLabel =
      coveredMinutes >= requestedMinutes - 0.25
        ? `${requestedMinutes.toFixed(0)} minutes`
        : `${coveredMinutes.toFixed(1)} of ${requestedMinutes.toFixed(0)} minutes`;
    return (
      <>
        <Row style={{ marginTop: "8px", marginBottom: "8px" }}>
          <Col md={6} sm={12} xs={24}>
            <HistoryCard
              title="CPU Trend"
              values={cpu}
              unit="%"
              color={COLORS.BLUE_D}
            />
          </Col>
          <Col md={6} sm={12} xs={24}>
            <HistoryCard
              title="Memory Trend"
              values={mem}
              unit="MiB"
              color={COLORS.ANTD_GREEN_D}
            />
          </Col>
        </Row>
        <Row style={{ marginBottom: "8px" }}>
          <Col md={12}>
            <div style={{ color: COLORS.GRAY_D, fontSize: "85%" }}>
              X-axis: oldest to newest sample, covering {coveredLabel} (
              {samples.length} samples, about every {sampleSeconds.toFixed(0)}s).
            </div>
          </Col>
        </Row>
      </>
    );
  }

  function render_details() {
    const proc =
      selected.length === 1 ? info?.processes?.[selected[0]] : undefined;
    return (
      <Form.Item>
        <Button
          type={"primary"}
          icon={<InfoCircleOutlined />}
          disabled={proc == null}
          onClick={() => set_modal(proc)}
        >
          {DETAILS_BTN_TEXT}
        </Button>
      </Form.Item>
    );
  }

  function render_action_buttons() {
    const disabled = disconnected || selected.length == 0;
    if (disabled || info?.processes == null) return;

    return (
      <>
        {render_details()}
        <SignalButtons
          selected={selected}
          set_selected={set_selected}
          loading={loading}
          disabled={disabled}
          processes={info.processes}
          project_actions={project_actions}
        />
      </>
    );
  }

  function render_refresh_button() {
    const refreshNow = async () => {
      if (refreshing) return;
      setRefreshing(true);
      try {
        await refresh();
      } finally {
        setRefreshing(false);
      }
    };
    return (
      <Form.Item>
        <Button
          icon={<ReloadOutlined />}
          onClick={() => void refreshNow()}
          loading={refreshing}
        >
          Refresh
        </Button>
      </Form.Item>
    );
  }

  function processHistory(
    proc: ProcessRow,
  ): { cpu: number[]; mem: number[]; timestamps: number[] } | undefined {
    const live = info?.processes?.[proc.pid];
    if (live == null) return;
    const id = `${live.pid}:${live.stat.starttime}`;
    return historyByProcessId.get(id);
  }

  function processHistoryForProcess(
    proc: Process | undefined,
  ): { cpu: number[]; mem: number[]; timestamps: number[] } | undefined {
    if (proc == null) return;
    const id = `${proc.pid}:${proc.stat.starttime}`;
    return historyByProcessId.get(id);
  }

  const renderCpuCell = onCellProps(
    "cpu_pct",
    (value) => value as unknown as number,
  );
  const renderMemCell = onCellProps(
    "mem",
    (value) => value as unknown as number,
  );

  function has_children(proc: ProcessRow): boolean {
    return proc.children != null && proc.children.length > 0;
  }

  function render_modal_footer() {
    return (
      <Button type={"primary"} onClick={() => set_modal(undefined)}>
        Ok
      </Button>
    );
  }

  function render_modals() {
    const renderModalFileLink = (proc: Process): React.JSX.Element | undefined => {
      const cocalc = proc.cocalc;
      if (cocalc == null) return;
      if (
        cocalc.type !== "jupyter" &&
        cocalc.type !== "terminal" &&
        cocalc.type !== "x11"
      ) {
        return;
      }
      const openPath = cocalc.path;
      const sourcePath = proc.origin?.path ?? openPath;
      const displayPath =
        sourcePath.startsWith("/") ? sourcePath : `/${sourcePath}`;
      const icon =
        cocalc.type === "jupyter"
          ? "ipynb"
          : cocalc.type === "terminal"
            ? "terminal"
            : "window-restore";
      return (
        <Button
          shape="round"
          icon={<Icon name={icon} />}
          onClick={() =>
            project_actions?.open_file({
              path: openPath,
              foreground: true,
            })
          }
          style={{ maxWidth: "100%" }}
        >
          <span
            style={{
              display: "inline-block",
              maxWidth: "52vw",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              verticalAlign: "bottom",
            }}
            title={displayPath}
          >
            {displayPath}
          </span>
        </Button>
      );
    };

    switch (modal) {
      case "ssh":
        return (
          <Modal
            title={`${projectLabel}'s SSH Daemon`}
            open={modal === "ssh"}
            footer={render_modal_footer()}
            onCancel={() => set_modal(undefined)}
          >
            <div>
              This process allows to SSH into this {projectLabelLower}. Do not
              terminate it!
              <br />
              Learn more: <A href={SSH_KEYS_DOC}>SSH keys documentation</A>
            </div>
          </Modal>
        );
      case "project":
        return (
          <Modal
            title={`${projectLabel}'s process`}
            open={modal === "project"}
            footer={render_modal_footer()}
            onCancel={() => set_modal(undefined)}
          >
            <div>
              This is the {projectLabelLower}'s own management process. Do not
              terminate it! If it uses too much resources, use the workspace
              controls outside this page.
            </div>
          </Modal>
        );
      default:
        if (modal != null && typeof modal !== "string") {
          const processes: Processes = info?.processes ?? { [modal.pid]: modal };
          const signalControls = (
            <div style={{ marginBottom: "8px" }}>
              <SignalButtons
                pid={modal.pid}
                loading={loading}
                processes={processes}
                project_actions={project_actions}
              />
            </div>
          );
          const modalFileLink = renderModalFileLink(modal);
          return (
            <Modal
              title="Process info"
              open
              width={"75vw"}
              footer={render_modal_footer()}
              onCancel={() => set_modal(undefined)}
            >
              {signalControls}
              {modalFileLink != null ? (
                <div style={{ marginBottom: "10px" }}>{modalFileLink}</div>
              ) : undefined}
              <AboutContent
                proc={modal}
                trend={processHistoryForProcess(modal)}
              />
            </Modal>
          );
        }
    }
  }

  function render_not_loading_info() {
    return (
      <>
        <div>
          <Loading theme="medium" transparent />
        </div>
        {show_long_loading && (
          <Alert
            type="info"
            title={
              <div>
                <p>
                  If the Table of Processes does not load, the project might be
                  malfunctioning or saturated by load.
                </p>
              </div>
            }
          />
        )}
      </>
    );
  }

  // mimic a table of processes program like htop – with tailored descriptions for cocalc
  function render_top() {
    if (ptree == null) {
      if (project_state === "running" && error == null) {
        // return <Loading />;
        return render_not_loading_info();
      } else {
        return null;
      }
    }

    const expandable = {
      defaultExpandAllRows: true,
      onExpandedRowsChange: (keys) => set_expanded(keys),
      rowExpandable: (proc) => has_children(proc),
    };

    const rowSelection = {
      selectedRowKeys: selected,
      onChange: select_proc,
    };

    const openRowProcessModal = (proc: ProcessRow) => {
      const live = info?.processes?.[proc.pid];
      if (live == null) return;
      set_selected([live.pid]);
      set_modal(live);
    };

    const shouldIgnoreRowClick = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      if (target.closest("[data-cocalc-role-cell='1']")) return true;
      if (target.closest(".ant-table-selection-column")) return true;
      if (target.closest(".ant-checkbox-wrapper")) return true;
      if (target.closest(".ant-table-row-expand-icon")) return true;
      if (target.closest("button,a,input,label")) return true;
      return false;
    };

    const cocalc_title = (
      <Tip
        title={"The role of these processes in this project."}
        trigger={["hover", "click"]}
      >
        <LabelQuestionmark text={"Role of Process"} />
      </Tip>
    );

    const state_title = (
      <Tip
        title={
          "Process state: running means it is actively using CPU, while sleeping means it waits for input."
        }
        trigger={["hover", "click"]}
      >
        <ScheduleOutlined />
      </Tip>
    );

    const table_style: CSS = {
      marginBottom: "2rem",
    };

    return (
      <>
        <Row
          ref={headerRef}
          style={{ marginBottom: "10px", marginTop: "20px" }}
        >
          <Col md={9}>
            <Form layout="inline">
              <Form.Item label="Table of Processes" />
              {render_refresh_button()}
              {render_action_buttons()}
              {render_disconnected()}
            </Form>
          </Col>
          <Col md={3}>
            <Form layout="inline" style={{ float: "right" }}>
              {render_help()}
            </Form>
          </Col>
        </Row>
        <Row>
          <Table<ProcessRow>
            key={`table-${contentSize.width}-${contentSize.height}`}
            dataSource={ptree}
            size={"small"}
            pagination={false}
            tableLayout="fixed"
            scroll={{ y: tableHeight }}
            style={table_style}
            expandable={expandable}
            rowSelection={rowSelection}
            loading={disconnected || loading}
            onRow={(proc) => ({
              onClick: (event) => {
                if (shouldIgnoreRowClick(event.target)) return;
                openRowProcessModal(proc);
              },
            })}
          >
            <Table.Column<ProcessRow>
              key="process"
              title="Process"
              width="35%"
              align={"left"}
              ellipsis={true}
              render={(proc) => (
                <span>
                  <b>{proc.name}</b> <span>{proc.args}</span>
                </span>
              )}
              sorter={field_cmp("name")}
            />
            <Table.Column<ProcessRow>
              key="cocalc"
              title={cocalc_title}
              width="20%"
              align={"left"}
              render={(proc) => (
                <div
                  data-cocalc-role-cell="1"
                  onClick={(event) => event.stopPropagation()}
                  style={{ width: "100%", overflow: "hidden" }}
                >
                  {render_cocalc(proc)}
                </div>
              )}
              sorter={field_cmp("cocalc")}
            />
            <Table.Column<ProcessRow>
              key="pid"
              title={"PID"}
              width="10%"
              align={"left"}
              render={onCellProps("pid", (x) =>
                x.pid == null ? "" : `${x.pid}`,
              )}
              sorter={field_cmp("pid")}
            />
            <Table.Column<ProcessRow>
              key="cpu_state"
              title={state_title}
              width="5%"
              align={"right"}
              render={(proc) => <ProcState state={proc.state} />}
              sorter={field_cmp("state")}
            />
            <Table.Column<ProcessRow>
              key="cpu_pct"
              title="CPU%"
              width="10%"
              dataIndex="cpu_pct"
              align={"right"}
              render={(value, proc) => {
                const display = renderCpuCell(value, proc) as number;
                const trend = processHistory(proc)?.cpu ?? [];
                return (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "end",
                    }}
                  >
                    <span>{display.toFixed(1)}%</span>
                    <MiniTrend
                      values={trend}
                      timestamps={processHistory(proc)?.timestamps ?? []}
                      color={COLORS.BLUE_D}
                      unit="%"
                      label="CPU"
                    />
                  </div>
                );
              }}
              onCell={onCellProps("cpu_pct")}
              sorter={inclusiveCmp("cpu_pct")}
            />
            <Table.Column<ProcessRow>
              key="cpu_tot"
              title="CPU Time"
              dataIndex="cpu_tot"
              width="10%"
              align={"right"}
              render={onCellProps("cpu_pct", (val) => seconds2hms(val))}
              onCell={onCellProps("cpu_tot")}
              sorter={inclusiveCmp("cpu_tot")}
            />
            <Table.Column<ProcessRow>
              key="mem"
              title="Memory"
              dataIndex="mem"
              width="10%"
              align={"right"}
              render={(value, proc) => {
                const display = renderMemCell(value, proc) as number;
                const trend = processHistory(proc)?.mem ?? [];
                return (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "end",
                    }}
                  >
                    <span>{display.toFixed(0)} MiB</span>
                    <MiniTrend
                      values={trend}
                      timestamps={processHistory(proc)?.timestamps ?? []}
                      color={COLORS.ANTD_GREEN_D}
                      unit="MiB"
                      label="Memory"
                    />
                  </div>
                );
              }}
              onCell={onCellProps("mem")}
              sorter={inclusiveCmp("mem")}
            />
          </Table>
        </Row>
      </>
    );
  }

  function render_general_status() {
    return (
      <Col md={12}>
        <div ref={generalStatusRef} style={{ color: COLORS.GRAY }}>
          Timestamp:{" "}
          {info?.timestamp != null ? (
            <code>{new Date(info.timestamp).toISOString()}</code>
          ) : (
            "no timestamp"
          )}{" "}
          | Status: <code>{status}</code>
        </div>
      </Col>
    );
  }

  function render_body() {
    return (
      <>
        <div ref={problemsRef}>
          <ProjectProblems project_status={project_status} />
        </div>
        <div ref={cgroupRef}>
          <CGroup
            have_cgroup={info?.cgroup != null}
            cg_info={cg_info}
            disk_usage={disk_usage}
            pt_stats={pt_stats}
            start_ts={start_ts}
            project_status={project_status}
          />
        </div>
        {render_history()}
        {render_top()}
        {render_modals()}
        {DEBUG && render_general_status()}
      </>
    );
  }

  function render_not_running() {
    if (project_state === "running") return;
    return (
      <Row>
        <Alert
          type="warning"
          banner={true}
          title={`${projectLabel} is not running.`}
        />
      </Row>
    );
  }

  return (
    <div style={{ ...ROOT_STYLE, maxWidth: undefined }}>
      {render_not_running()}
      {error}
      {render_body()}
    </div>
  );
}
