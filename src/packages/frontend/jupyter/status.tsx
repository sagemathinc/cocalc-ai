/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Kernel display

import { CSS, React, redux, useRedux } from "@cocalc/frontend/app-framework";
import {
  A,
  Icon,
  IconName,
  Loading,
  Tooltip,
} from "@cocalc/frontend/components";
import { DocsLink } from "@cocalc/frontend/docs/link";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import type {
  AlertLevel,
  BackendState,
  KernelState,
  Usage,
} from "@cocalc/jupyter/types";
import { capitalize, closest_kernel_match, rpad_html } from "@cocalc/util/misc";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  Button,
  Checkbox,
  Drawer,
  Divider,
  Modal,
  Popover,
  Popconfirm,
  Progress,
  Space,
  Tabs,
  Typography,
} from "antd";
import * as immutable from "immutable";
import { ReactNode, useEffect } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import ProgressEstimate from "../components/progress-estimate";
import { labels } from "../i18n";
import { JupyterActions } from "./browser-actions";
import Logo from "./logo";
import { StudioControls } from "./studio/studio-controls";
import type { StudioLayout } from "./studio/types";
import { KernelSelector } from "./select-kernel";
import { ALERT_COLS } from "./usage";

const KERNEL_NAME_STYLE: CSS = {
  margin: "0px 5px",
  display: "block",
  color: UI_COLORS.link,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
} as const;

const KERNEL_USAGE_STYLE: CSS = {
  margin: "0px 5px",
  color: UI_COLORS.secondary,
  borderRight: `1px solid ${UI_COLORS.border}`,
  paddingRight: "5px",
  display: "flex",
  alignItems: "center",
  flex: 1,
} as const;

const KERNEL_USAGE_STYLE_NUM: CSS = {
  fontFamily: "monospace",
} as const;

const KERNEL_ERROR_STYLE: CSS = {
  margin: "5px",
  color: UI_COLORS.danger,
  padding: "5px",
  backgroundColor: UI_COLORS.dangerBg,
} as const;

const MEMORY_DOCS_SLUG = "troubleshooting/memory";

const BACKEND_STATE_STYLE: CSS = {
  display: "flex",
  marginRight: "5px",
  color: KERNEL_NAME_STYLE.color,
  fontSize: "18px",
} as const;

const BACKEND_STATE_HUMAN = {
  init: "Initializing",
  ready: "Ready to start",
  starting: "Starting",
  running: "Running",
} as const;

const DISPLAY_BUSY_DELAY_MS = 350;
const DISPLAY_BUSY_MIN_MS = 1000;

const KERNEL_DRAWER_WIDTH_STORAGE_KEY = "cocalc:jupyter:kernelDrawerWidth";
const MIN_KERNEL_DRAWER_WIDTH = 360;
const MAX_KERNEL_DRAWER_WIDTH = 960;

function clampKernelDrawerWidth(width: number): number {
  return Math.min(
    MAX_KERNEL_DRAWER_WIDTH,
    Math.max(MIN_KERNEL_DRAWER_WIDTH, width),
  );
}

function readKernelDrawerWidth(): number | undefined {
  if (typeof window === "undefined") {
    return;
  }
  const raw = window.localStorage.getItem(KERNEL_DRAWER_WIDTH_STORAGE_KEY);
  if (raw == null) {
    return;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return;
  }
  return clampKernelDrawerWidth(parsed);
}

function persistKernelDrawerWidth(width: number) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(
    KERNEL_DRAWER_WIDTH_STORAGE_KEY,
    String(clampKernelDrawerWidth(width)),
  );
}

interface KernelProps {
  actions: JupyterActions;
  usage?: Usage;
  expected_cell_runtime?: number;
  style?: CSS;
  hideHeader?: boolean;
  compact?: boolean;
  /** Studio notebook layout controls */
  studioLayout?: StudioLayout;
  readingMode?: boolean;
  onLayoutChange?: (layout: StudioLayout) => void;
  onReadingModeChange?: (reading: boolean) => void;
  availableLayouts?: readonly StudioLayout[];
  /**
   * How much room the usage meters may take in the header. "hidden" only
   * suppresses the header meters: `usage` itself keeps flowing so the kernel
   * drawer still shows the numbers.
   */
  usageDisplay?: "full" | "mini" | "hidden";
  /** Drop control text labels, keeping icons, for very narrow frames. */
  iconsOnly?: boolean;
}

export function Kernel({
  actions,
  expected_cell_runtime,
  style,
  usage,
  hideHeader,
  compact,
  studioLayout,
  readingMode,
  onLayoutChange,
  onReadingModeChange,
  availableLayouts,
  usageDisplay = "full",
  iconsOnly,
}: KernelProps) {
  const intl = useIntl();
  const name = actions.name;

  // redux section
  const trust: undefined | boolean = useRedux([name, "trust"]);
  const read_only: undefined | boolean = useRedux([name, "read_only"]);
  const redux_kernel = useRedux([name, "kernel"]);
  const kernel_undecided = redux_kernel == null;
  const no_kernel = redux_kernel === "";
  // no redux_kernel or empty string (!) means there is no kernel
  const kernel: string | null = !redux_kernel ? null : redux_kernel;
  const kernels: undefined | immutable.List<any> = useRedux([name, "kernels"]);
  const runProgress = useRedux([name, "runProgress"]);
  const redux_project_id: string | undefined = useRedux([name, "project_id"]);
  const project_id = redux_project_id ?? actions.project_id;
  const project_actions = React.useMemo(
    () =>
      project_id != null ? redux.getProjectActions(project_id) : undefined,
    [project_id],
  );
  const kernel_info: undefined | immutable.Map<string, any> = useRedux([
    name,
    "kernel_info",
  ]);
  const isRemoteKernel =
    kernel_info?.getIn(["metadata", "reflect", "remote"]) === true;
  const show_kernel_selector: undefined | boolean = useRedux([
    name,
    "show_kernel_selector",
  ]);
  const backend_state: undefined | BackendState = useRedux([
    name,
    "backend_state",
  ]);
  const kernel_state: undefined | KernelState = useRedux([
    name,
    "kernel_state",
  ]);
  const [displayKernelState, setDisplayKernelState] = React.useState<
    undefined | KernelState
  >(kernel_state);
  const displayedBusySinceRef = React.useRef<number | null>(null);
  const pendingBusyTimerRef = React.useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
  const pendingIdleTimerRef = React.useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);

  useEffect(() => {
    return () => {
      if (pendingBusyTimerRef.current != null) {
        clearTimeout(pendingBusyTimerRef.current);
      }
      if (pendingIdleTimerRef.current != null) {
        clearTimeout(pendingIdleTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (pendingBusyTimerRef.current != null) {
      clearTimeout(pendingBusyTimerRef.current);
      pendingBusyTimerRef.current = undefined;
    }
    if (pendingIdleTimerRef.current != null) {
      clearTimeout(pendingIdleTimerRef.current);
      pendingIdleTimerRef.current = undefined;
    }
    if (backend_state !== "running") {
      displayedBusySinceRef.current = null;
      setDisplayKernelState(kernel_state);
      return;
    }
    if (kernel_state === "busy") {
      if (displayKernelState === "busy") {
        return;
      }
      pendingBusyTimerRef.current = setTimeout(() => {
        displayedBusySinceRef.current = Date.now();
        setDisplayKernelState("busy");
        pendingBusyTimerRef.current = undefined;
      }, DISPLAY_BUSY_DELAY_MS);
      return;
    }
    if (displayKernelState !== "busy") {
      displayedBusySinceRef.current = null;
      setDisplayKernelState(kernel_state);
      return;
    }
    const elapsed =
      displayedBusySinceRef.current == null
        ? DISPLAY_BUSY_MIN_MS
        : Date.now() - displayedBusySinceRef.current;
    const remaining = Math.max(0, DISPLAY_BUSY_MIN_MS - elapsed);
    pendingIdleTimerRef.current = setTimeout(() => {
      displayedBusySinceRef.current = null;
      setDisplayKernelState(kernel_state);
      pendingIdleTimerRef.current = undefined;
    }, remaining);
  }, [backend_state, kernel_state, displayKernelState]);

  const backendIsStarting =
    backend_state === "starting" || backend_state === "spawning";
  const displayKernelStateValue =
    backend_state === "running" ? displayKernelState : kernel_state;
  const haltTooltip = intl.formatMessage({
    id: "jupyter.status.halt_idle_tooltip",
    defaultMessage:
      "Terminate the kernel process? All variable state will be lost.",
    description: "Terminating the kernel of a Jupyter Notebook",
  });

  const [isSpwarning, setIsSpawarning] = React.useState(false);
  useEffect(() => {
    if (isSpwarning && !backendIsStarting) {
      setIsSpawarning(false);
    } else if (!isSpwarning && backendIsStarting) {
      setIsSpawarning(true);
    }
  }, [backend_state]);
  const [kernelDrawerOpen, setKernelDrawerOpen] =
    React.useState<boolean>(false);
  const [defaultKernelOnSelect, setDefaultKernelOnSelect] =
    React.useState<boolean>(false);
  const [kernelDrawerWidth, setKernelDrawerWidth] = React.useState<
    number | undefined
  >(readKernelDrawerWidth);
  useEffect(() => {
    setKernelDrawerOpen(!!show_kernel_selector);
  }, [show_kernel_selector]);
  useEffect(() => {
    if (!kernelDrawerOpen) {
      setDefaultKernelOnSelect(false);
    }
  }, [kernelDrawerOpen]);

  // render functions start there

  function openKernelDrawer() {
    void actions.show_select_kernel("user request");
  }

  function closeKernelDrawer() {
    actions.hide_select_kernel();
  }

  function onKernelSelectedFromPrompt(kernelName: string) {
    if (!kernel_undecided || !defaultKernelOnSelect) return;
    if (!kernelName) return;
    actions.kernel_dont_ask_again(true);
  }

  function handleDrawerResize(next: number) {
    const clamped = clampKernelDrawerWidth(next);
    setKernelDrawerWidth(clamped);
    try {
      persistKernelDrawerWidth(clamped);
    } catch {}
  }

  // wrap "Logo" component
  function renderLogo() {
    if (project_id == null) {
      return;
    }
    return <Logo kernel={kernel} />;
  }

  // this renders the name of the kernel, if known, or a button to change to a similar but known one
  function render_name() {
    let display_name = kernel_info?.get("display_name");
    if (display_name == null && kernel != null && kernels != null) {
      // Definitely an unknown kernel
      const closestKernel = closest_kernel_match(
        kernel,
        kernels as any, // TODO
      );
      if (closestKernel == null) {
        return <span style={KERNEL_ERROR_STYLE}>Unknown kernel</span>;
      } else {
        const closestKernelDisplayName = closestKernel.get("display_name");
        const closestKernelName = closestKernel.get("name") as string;
        return (
          <span
            style={KERNEL_ERROR_STYLE}
            onClick={() => actions.set_kernel(closestKernelName)}
          >
            Unknown kernel <span style={{ fontWeight: "bold" }}>{kernel}</span>,
            click here to use {closestKernelDisplayName || "No Kernel"} instead.
          </span>
        );
      }
    } else {
      // List of known kernels just not loaded yet.
      if (display_name == null) {
        display_name = kernel ?? "No Kernel";
      }
      const style = {
        ...KERNEL_NAME_STYLE,
        maxWidth: compact ? "14em" : "20em",
      };
      return (
        <div style={style} onClick={openKernelDrawer}>
          {display_name}
        </div>
      );
    }
  }

  // at the very right, an icon to indicate at a quick glance if the kernel is active or not
  function render_backend_state_icon() {
    if (read_only) {
      return;
    }
    if (backend_state == null) {
      return <Loading />;
    }
    /*
      The backend_states are:
         'init' --> 'ready'  --> 'spawning' --> 'starting' --> 'running'

      When the backend_state is 'running', then the kernel_state is either
          'idle' or 'running'
      */
    let spin = false;
    let name: IconName | undefined;
    let color: string | undefined;
    switch (backend_state) {
      case "failed":
        name = "bug";
        break;
      case "off":
      case "closed":
        name = "unlink";
        break;
      case "spawning":
      case "starting":
        name = "cocalc-ring";
        spin = true;
        break;
      case "running":
        switch (displayKernelStateValue) {
          case "busy":
            name = "circle";
            color = UI_COLORS.success;
            break;
          case "idle":
            name = "cocalc-ring";
            break;
          default:
            name = "cocalc-ring";
        }
        break;
    }

    return (
      <div style={BACKEND_STATE_STYLE}>
        <Icon name={name} spin={spin} style={{ color }} />
      </div>
    );
  }

  function render_trust() {
    // Keep non-notebook compact embeds (e.g. whiteboard code elements) free
    // of the trust indicator; the studio notebook status bar (compact with
    // layout controls) shows it just like the regular status bar.
    if (compact && onLayoutChange == null) return;
    if (IS_MOBILE) return;
    if (trust) {
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            color: UI_COLORS.secondary,
            paddingLeft: "6px",
            borderLeft: `1px solid ${UI_COLORS.border}`,
            whiteSpace: "nowrap",
          }}
        >
          Trusted
        </div>
      );
    } else {
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            paddingLeft: "6px",
            borderLeft: `1px solid ${UI_COLORS.border}`,
            whiteSpace: "nowrap",
          }}
        >
          <Tooltip
            title={intl.formatMessage({
              id: "jupyter.status.trust.no.tooltip",
              defaultMessage: "Notebook is not trusted",
              description: "The Jupyter Notebook content is not trusted",
            })}
          >
            <Button
              danger
              onClick={(e) => {
                // don't let the click bubble to the surrounding kernel-info
                // area, which would also open the kernel drawer
                e.stopPropagation();
                actions.trust_notebook();
              }}
              size="small"
            >
              {intl.formatMessage({
                id: "jupyter.status.trust.no",
                defaultMessage: "Not Trusted",
                description: "Jupyter Notebook content is not trusted",
              })}
            </Button>
          </Tooltip>
        </div>
      );
    }
  }

  function kernelState(): ReactNode {
    if (kernel === null) {
      return (
        <>
          {intl.formatMessage({
            id: "jupyter.status.no_kernel",
            defaultMessage: "No kernel",
          })}{" "}
          <Tooltip title={intl.formatMessage(labels.select_a_kernel)}>
            <a
              onClick={() => {
                openKernelDrawer();
              }}
            >
              ({intl.formatMessage(labels.select)}...)
            </a>
          </Tooltip>
        </>
      );
    }

    if (backend_state === "running") {
      switch (displayKernelStateValue) {
        case "busy":
          return (
            <>
              Busy{" "}
              <Tooltip
                title={intl.formatMessage({
                  id: "jupyter.status.interrupt_tooltip",
                  defaultMessage: "Interrupt the running computation",
                })}
              >
                <a
                  onClick={() => {
                    // using actions rather than frame actions, since I want
                    // this to work in places other than Jupyter notebooks.
                    actions.signal("SIGINT");
                  }}
                >
                  (interrupt)
                </a>
              </Tooltip>
            </>
          );
        case "idle":
          return (
            <>
              Idle{" "}
              <Popconfirm
                title={haltTooltip}
                onConfirm={() => {
                  actions.shutdown();
                }}
                okText={intl.formatMessage(labels.halt)}
                cancelText={intl.formatMessage(labels.cancel)}
              >
                <Tooltip title={haltTooltip}>
                  <a>(halt...)</a>
                </Tooltip>
              </Popconfirm>
            </>
          );
      }
    } else if (backendIsStarting) {
      return intl.formatMessage({
        id: "jupyter.status.backend_starting",
        defaultMessage: "Starting",
        description: "The kernel of a Jupyter Notebook is starting",
      });
    }
    return null;
  }

  function kernelStateCompact(): ReactNode {
    if (kernel === null) {
      return intl.formatMessage({
        id: "jupyter.status.no_kernel",
        defaultMessage: "No kernel",
      });
    }
    if (backend_state === "running") {
      switch (displayKernelStateValue) {
        case "busy":
          return "Busy";
        case "idle":
          return "Idle";
      }
    } else if (backendIsStarting) {
      return intl.formatMessage({
        id: "jupyter.status.backend_starting",
        defaultMessage: "Starting",
        description: "The kernel of a Jupyter Notebook is starting",
      });
    }
    return null;
  }

  function get_kernel_name(): React.JSX.Element {
    if (kernel_info != null) {
      const name = kernel_info.get(
        "display_name",
        kernel_info.get("name", "No Kernel"),
      );
      return <div>Kernel: {name}</div>;
    } else {
      return <span />;
    }
  }

  function renderDrawerActions(): React.JSX.Element {
    const canRestart = !read_only && kernel != null && !no_kernel;
    const canHalt = !read_only && backend_state === "running";
    return (
      <Space size={8}>
        <Button
          size="small"
          disabled={!canRestart}
          onClick={() => void actions.confirm_restart()}
        >
          Restart
        </Button>
        <Popconfirm
          title={haltTooltip}
          onConfirm={() => {
            actions.shutdown();
          }}
          okText={intl.formatMessage(labels.halt)}
          cancelText={intl.formatMessage(labels.cancel)}
          disabled={!canHalt}
        >
          <Button size="small" disabled={!canHalt}>
            Halt
          </Button>
        </Popconfirm>
      </Space>
    );
  }

  function renderKernelState() {
    if (!backend_state) return <div></div>;
    // Display the plain state word in both the regular and the studio
    // status bar; interrupt/halt are separate borderless buttons next to it.
    const value = kernelStateCompact();
    return (
      <Tooltip title={kernelState()} placement="bottom">
        <div
          style={{
            flex: "0 0 auto",
            color: UI_COLORS.secondary,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            fontSize: IS_MOBILE ? "10pt" : undefined,
          }}
        >
          {value}
        </div>
      </Tooltip>
    );
  }

  // Borderless action button next to the kernel state: interrupt while
  // busy, halt (with confirmation) while idle.
  function renderKernelStateAction(): ReactNode {
    if (read_only || backend_state !== "running") return null;
    const buttonStyle: CSS = {
      color: UI_COLORS.secondary,
      padding: "0 6px",
    };
    switch (displayKernelStateValue) {
      case "busy":
        return (
          <Tooltip
            title={intl.formatMessage({
              id: "jupyter.status.interrupt_tooltip",
              defaultMessage: "Interrupt the running computation",
            })}
          >
            <Button
              size="small"
              type="text"
              style={buttonStyle}
              onClick={(e) => {
                e.stopPropagation();
                // using actions rather than frame actions, since this should
                // work in places other than Jupyter notebooks.
                actions.signal("SIGINT");
              }}
            >
              {/* intentionally untranslated (i18n style guide: short
                  Jupyter actions like Run stay English; the tooltip above
                  is translated) */}
              Interrupt
            </Button>
          </Tooltip>
        );
      case "idle":
        return (
          <Popconfirm
            title={haltTooltip}
            onConfirm={() => {
              actions.shutdown();
            }}
            okText={intl.formatMessage(labels.halt)}
            cancelText={intl.formatMessage(labels.cancel)}
          >
            <Tooltip title={haltTooltip}>
              <Button
                size="small"
                type="text"
                style={buttonStyle}
                onClick={(e) => e.stopPropagation()}
              >
                {/* trailing dots: the button opens a confirmation dialog */}
                {intl.formatMessage(labels.halt)}...
              </Button>
            </Tooltip>
          </Popconfirm>
        );
    }
    return null;
  }

  // detailed kernel information displayed in the kernel drawer.
  function renderKernelDetails() {
    const openProcessInfo = () => {
      if (actions.path == null) return;
      actions.hide_select_kernel();
      project_actions?.setState({
        project_info_focus: {
          kind: "jupyter",
          path: actions.path,
          requested_at: Date.now(),
        },
      });
      project_actions?.set_active_tab("info");
    };

    const backend_tip =
      backend_state == null ? (
        ""
      ) : (
        <>
          Backend is {BACKEND_STATE_HUMAN[backend_state] ?? backend_state} in
          the project.
          <br />
        </>
      );
    const kernel_tip = kernelState();

    const usage_tip = (
      <FormattedMessage
        id="jupyter.status.usage_tip"
        defaultMessage={`
        <p>
          This shows this kernel's resource usage. Memory is measured for the
          kernel and its child processes relative to the project's RAM limit.
          Open the "{processes}" tab to see all activities in this project.
        </p>
        <p>
          <secondary>
            Other processes in the project share the same RAM limit and are not
            included in this kernel's usage bar.
          </secondary>
        </p>
        <p>
          <secondary>
            You can clear all cpu and memory usage by <em>restarting your kernel</em>.
            Learn more about <A>Low Memory</A> mitigations.
          </secondary>
        </p>`}
        values={{
          processes: intl.formatMessage(labels.project_info_title),
          em: (ch) => <em>{ch}</em>,
          A: (ch) => (
            <DocsLink projectId={project_id} slug={MEMORY_DOCS_SLUG}>
              {ch}
            </DocsLink>
          ),
          secondary: (ch) => (
            <Typography.Text type="secondary">{ch}</Typography.Text>
          ),
        }}
      />
    );

    const usage_help = (
      <div style={{ marginTop: "8px" }}>
        <Popover
          trigger="click"
          placement="left"
          content={<div style={{ maxWidth: "360px" }}>{usage_tip}</div>}
        >
          <Button size="small" type="text" style={{ paddingInline: 6 }}>
            <Icon name="question-circle" /> Usage help
          </Button>
        </Popover>
      </div>
    );

    const description = kernel_info?.getIn([
      "metadata",
      "cocalc",
      "description",
    ]);
    const language = capitalize(kernel_info?.get("language", "Unknown"));
    const langTxt = `${language}${description ? ` (${description})` : ""}`;
    const langURL = kernel_info?.getIn(["metadata", "cocalc", "url"]) as
      | string
      | undefined;
    const lang = (
      <>
        Language: {langURL != null ? <A href={langURL}>{langTxt}</A> : langTxt}
        <br />
      </>
    );

    const tip = (
      <span>
        {lang}
        {backend_tip}
        {kernel_tip}
        <Divider style={{ margin: "8px 0" }} />
        {render_usage_text()}
        {!isRemoteKernel && actions.path != null ? (
          <div style={{ marginBottom: "8px" }}>
            <Button size="small" onClick={openProcessInfo}>
              Open in Processes
            </Button>
          </div>
        ) : undefined}
        {!isRemoteKernel && usage_help}
      </span>
    );
    return <div style={{ maxWidth: "100%", paddingTop: "4px" }}>{tip}</div>;
  }

  // show progress bar indicators for memory usage and the progress of the current cell (expected time)
  // if not fullscreen, i.e. smaller, pack this into two small bars.
  // the main use case is to communicate to the user if there is a cell that takes extraordinarily long to run,
  // or if the memory usage is eating up almost all of the reminining (shared) memory.

  function renderUsage() {
    if (kernel == null) return;
    if (isRemoteKernel) return;
    // Checked before the startup estimate below, which has no usage of its own
    // and would otherwise keep taking 300px in a frame with no room for it.
    if (usageDisplay === "hidden") return;

    if (isSpwarning) {
      const usage_style: CSS = KERNEL_USAGE_STYLE;
      const pstyle: CSS = {
        margin: "2px",
        width: compact ? "80px" : "175px",
        position: "relative",
        top: "-3px",
      };
      // we massively overestimate: 15s for python and co, and 30s for sage and julia
      const s =
        kernel.startsWith("sage") || kernel.startsWith("julia") ? 30 : 15;
      return (
        <div style={{ ...usage_style, display: "flex" }}>
          <ProgressEstimate style={pstyle} seconds={s} />
        </div>
      );
    }

    // unknown, e.g, not reporting/working or old backend.
    if (usage == null || expected_cell_runtime == null) return;

    // const status = usage.cpu > 50 ? "active" : undefined
    // const status = usage.cpu_runtime != null ? "active" : undefined;
    // **WARNING**: Including the status icon (which is computed above,
    // and done via status={status} for cpu below), leads to a MASSIVE
    // RENDERING BUG, where the cpu burns at like 50% anytime a Jupyter
    // notebook is being displayed. See
    //      https://github.com/sagemathinc/cocalc/issues/5185
    // we calibrate "100%" at the median – color changes at 2 x timings_q
    const cpu_val = Math.min(
      100,
      100 * (usage.cpu_runtime / expected_cell_runtime),
    );

    const railColor = UI_COLORS.border;

    // Narrow frame: the same three readings stacked as unlabeled bars, so
    // they cost ~50px instead of ~300px and the rest of the bar still fits.
    if (usageDisplay === "mini") {
      const meters: {
        key: string;
        label: string;
        percent: number;
        strokeColor?: string;
      }[] = [
        ...(runProgress != null
          ? [{ key: "code", label: "Code", percent: runProgress }]
          : []),
        {
          key: "cpu",
          label: "CPU",
          percent: cpu_val,
          strokeColor: ALERT_COLS[usage.time_alert],
        },
        {
          key: "ram",
          label: "RAM",
          percent: usage.mem_pct,
          strokeColor: ALERT_COLS[usage.mem_alert],
        },
      ];
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: "1px",
            width: "50px",
            borderLeft: `1px solid ${UI_COLORS.border}`,
            paddingLeft: "6px",
            cursor: "pointer",
          }}
        >
          {meters.map(({ key, label, percent, strokeColor }) => (
            <Tooltip key={key} title={`${label}: ${Math.round(percent)}%`}>
              <Progress
                aria-label={label}
                style={{ margin: 0, lineHeight: 1 }}
                showInfo={false}
                percent={percent}
                size="small"
                railColor={railColor}
                strokeColor={strokeColor}
              />
            </Tooltip>
          ))}
        </div>
      );
    }

    // same appearance in the regular and the studio status bar
    const style: CSS = {
      display: "flex",
      width: "300px",
      borderLeft: `1px solid ${UI_COLORS.border}`,
      cursor: "pointer",
      alignItems: "center",
    };
    const pstyle: CSS = {
      margin: "0 2px",
      width: "100%",
    };
    const showLabel = true;
    const usage_style: CSS = {
      ...KERNEL_USAGE_STYLE,
      borderRight: "none",
      margin: "0 4px",
      paddingRight: 0,
      alignItems: "center",
    };

    return (
      <div style={style}>
        {runProgress != null && (
          <Tooltip
            title={
              <>
                Percent of code cells that have been run since the kernel
                started.
              </>
            }
          >
            <div style={usage_style}>
              {showLabel ? (
                <span
                  style={{ marginRight: "5px", color: UI_COLORS.secondary }}
                >
                  Code
                </span>
              ) : (
                ""
              )}
              <Progress
                style={pstyle}
                showInfo={false}
                percent={runProgress}
                size="small"
                railColor={railColor}
              />
            </div>
          </Tooltip>
        )}
        <div style={usage_style}>
          {showLabel ? (
            <span style={{ marginRight: "5px", color: UI_COLORS.secondary }}>
              CPU
            </span>
          ) : (
            ""
          )}
          <Progress
            style={pstyle}
            showInfo={false}
            percent={cpu_val}
            size="small"
            railColor={railColor}
            strokeColor={ALERT_COLS[usage.time_alert]}
          />
        </div>
        <div style={usage_style}>
          {showLabel ? (
            <span style={{ marginRight: "5px", color: UI_COLORS.secondary }}>
              RAM
            </span>
          ) : (
            ""
          )}
          <Progress
            style={pstyle}
            showInfo={false}
            percent={usage.mem_pct}
            size="small"
            railColor={railColor}
            strokeColor={ALERT_COLS[usage.mem_alert]}
          />
        </div>
      </div>
    );
  }

  // helper for render_usage_text
  function usage_text_style_level(level: AlertLevel) {
    // Pair highlighted readings with a foreground for the same theme.
    const style = KERNEL_USAGE_STYLE_NUM;
    switch (level) {
      case "low":
      case "mid":
        return {
          ...style,
          backgroundColor: UI_COLORS.warningBg,
          color: UI_COLORS.warning,
        };
      case "high":
        return {
          ...style,
          backgroundColor: UI_COLORS.dangerBg,
          color: UI_COLORS.danger,
        };
      case "none":
      default:
        return style;
    }
  }

  // this ends up in the popover tip. it contains the actual values and the same color coded usage levels
  function render_usage_text() {
    if (isRemoteKernel) {
      return (
        <Typography.Text type="secondary">
          Remote kernel CPU and memory usage are unavailable.
        </Typography.Text>
      );
    }
    if (usage == null) return;

    const cpu_style = usage_text_style_level(usage.cpu_alert);
    const memory_style = usage_text_style_level(usage.mem_alert);
    const time_style = usage_text_style_level(usage.time_alert);
    const { cpu, mem, mem_pct } = usage;
    const cpu_disp = `${rpad_html(cpu, 3)}%`;
    const mem_disp = `${rpad_html(mem, 4)}MB`;
    const round = (val) => val.toFixed(1);
    const time_disp = `${rpad_html(usage.cpu_runtime, 5, round)}s`;
    const mem_pct_disp = `${rpad_html(mem_pct, 3)}%`;
    const style: CSS = { whiteSpace: "nowrap" };
    return (
      <p style={style}>
        <span>
          CPU{" "}
          <span
            className={"cocalc-jupyter-usage-info"}
            style={cpu_style}
            dangerouslySetInnerHTML={{ __html: cpu_disp }}
          />
        </span>
        <span>
          Time:{" "}
          <span
            className={"cocalc-jupyter-usage-info"}
            style={time_style}
            dangerouslySetInnerHTML={{ __html: time_disp }}
          />
        </span>
        <span>
          Memory{" "}
          <span
            className={"cocalc-jupyter-usage-info"}
            style={memory_style}
            dangerouslySetInnerHTML={{ __html: mem_disp }}
          />
          <span
            className={"cocalc-jupyter-usage-info"}
            style={memory_style}
            dangerouslySetInnerHTML={{ __html: mem_pct_disp }}
          />
        </span>
      </p>
    );
  }

  const info = (
    <div
      style={{
        display: "flex",
        flex: "1 0",
        flexDirection: "row",
        flexWrap: "nowrap",
      }}
    >
      {render_name()}
      {render_backend_state_icon()}
    </div>
  );

  const body = (
    <div
      style={{
        color: UI_COLORS.secondary,
        cursor: "pointer",
      }}
      onClick={openKernelDrawer}
    >
      {info}
    </div>
  );

  return (
    <>
      {!hideHeader && compact && (
        <div
          style={{
            overflow: "hidden",
            width: "100%",
            // without border-box, 100% + padding overflows the frame and
            // spawns a horizontal scrollbar at the bottom of the notebook
            boxSizing: "border-box",
            padding: "4px 6px",
            backgroundColor: UI_COLORS.inset,
            color: UI_COLORS.text,
            display: "flex",
            alignItems: "center",
            gap: "6px",
            borderBottom: `1px solid ${UI_COLORS.border}`,
            ...style,
          }}
        >
          {/* Left: logo + kernel + trust. Shrinkable, and the first thing to
              give way when the frame is narrow: the kernel name already
              ellipsizes, so it costs the least. Without this the group is
              rigid and the overflow lands on the controls at the far right,
              cutting off Help and the switch back to Classic. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              flex: "0 1 auto",
              minWidth: 0,
              // the logo and the trust indicator have a min-content width of
              // their own, so once the kernel name has ellipsized away they
              // would spill out of the shrunken group and paint on top of the
              // meters next to it; clip instead of overlapping.
              overflow: "hidden",
            }}
          >
            {/* flex wrapper: a plain div adds baseline descender space below
                the inline logo, which pushes the logo visually too high */}
            <div style={{ display: "flex", alignItems: "center" }}>
              {renderLogo()}
            </div>
            {body}
            {render_trust()}
          </div>
          {/* Middle: kernel state centered between the fixed side groups,
              so the left group doesn't shift when the state text changes */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
            }}
          >
            {renderKernelState()}
            {renderKernelStateAction()}
          </div>
          {/* Right: bars + controls. Never shrinks, so the view switch stays
              reachable however narrow the frame gets. */}
          {onLayoutChange && (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                flex: "0 0 auto",
              }}
            >
              {!IS_MOBILE && (
                <div
                  style={{ cursor: "pointer", flex: "0 0 auto" }}
                  onClick={openKernelDrawer}
                >
                  {renderUsage()}
                </div>
              )}
              <StudioControls
                studioLayout={studioLayout}
                availableLayouts={availableLayouts}
                onLayoutChange={onLayoutChange}
                readingMode={readingMode}
                onReadingModeChange={onReadingModeChange}
                iconsOnly={iconsOnly}
              />
            </div>
          )}
        </div>
      )}
      {!hideHeader && !compact && (
        <div
          style={{
            overflow: "hidden",
            width: "100%",
            // see compact header: avoid 100%+padding horizontal overflow
            boxSizing: "border-box",
            padding: "5px",
            backgroundColor: UI_COLORS.inset,
            color: UI_COLORS.text,
            display: "flex",
            alignItems: "center",
            gap: "6px",
            borderBottom: `1px solid ${UI_COLORS.border}`,
            ...style,
          }}
        >
          {/* Left: logo + kernel + trust, like the studio status bar — and
              shrinking and clipping for the same reason, so a narrow frame
              eats into the kernel name rather than the controls at the end. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              flex: "0 1 auto",
              minWidth: 0,
              overflow: "hidden",
            }}
          >
            {/* flex wrapper: see compact header — avoids baseline gap below
                the inline logo */}
            <div style={{ display: "flex", alignItems: "center" }}>
              {renderLogo()}
            </div>
            {body}
            {render_trust()}
          </div>
          {/* Middle: kernel state centered, see compact header */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
            }}
          >
            {renderKernelState()}
            {renderKernelStateAction()}
          </div>
          {/* Right: usage bars + switch button */}
          {!IS_MOBILE && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                cursor: "pointer",
                flex: "0 0 auto",
              }}
              onClick={openKernelDrawer}
            >
              {renderUsage()}
            </div>
          )}
        </div>
      )}
      {kernel_undecided ? (
        <Modal
          open={kernelDrawerOpen}
          onCancel={closeKernelDrawer}
          title={intl.formatMessage({
            id: "jupyter.status.select_kernel_modal_title",
            defaultMessage: "Select a kernel",
          })}
          width={Math.min(760, Math.max(520, (kernelDrawerWidth ?? 640) - 120))}
          footer={
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Checkbox
                checked={defaultKernelOnSelect}
                onChange={(e) => setDefaultKernelOnSelect(e.target.checked)}
              >
                {intl.formatMessage({
                  id: "jupyter.status.default_kernel_on_select",
                  defaultMessage: "Default to this kernel in the future",
                })}
              </Checkbox>
              <Button onClick={closeKernelDrawer}>
                {intl.formatMessage(labels.cancel)}
              </Button>
            </div>
          }
          destroyOnHidden={false}
          mask={{ closable: false }}
        >
          <Tabs
            size="small"
            defaultActiveKey="kernels"
            items={[
              {
                key: "kernels",
                label: "Kernels",
                children: (
                  <KernelSelector
                    actions={actions}
                    embedded
                    onSelectKernel={onKernelSelectedFromPrompt}
                  />
                ),
              },
              {
                key: "info",
                label: "Info",
                children: renderKernelDetails(),
              },
            ]}
          />
        </Modal>
      ) : (
        <Drawer
          open={kernelDrawerOpen}
          onClose={closeKernelDrawer}
          placement="right"
          size={kernelDrawerWidth}
          resizable={{ onResize: handleDrawerResize }}
          title={get_kernel_name()}
          extra={renderDrawerActions()}
        >
          <Tabs
            size="small"
            defaultActiveKey="kernels"
            items={[
              {
                key: "kernels",
                label: "Kernels",
                children: <KernelSelector actions={actions} embedded />,
              },
              {
                key: "info",
                label: "Info",
                children: renderKernelDetails(),
              },
            ]}
          />
        </Drawer>
      )}
    </>
  );
}
