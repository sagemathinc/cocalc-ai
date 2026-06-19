/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// cSpell: ignore descr prio dont

// help users selecting a kernel
import type { TabsProps } from "antd";
import {
  Button,
  Card,
  Checkbox,
  Descriptions,
  Modal,
  Popover,
  Spin,
  Space,
  Tabs,
  Typography,
} from "antd";
import { Map as ImmutableMap, List, OrderedMap } from "immutable";
import { FormattedMessage, useIntl } from "react-intl";
import {
  CSS,
  Rendered,
  redux,
  useRedux,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { useEffect, useMemo, useState } from "react";
import { alert_message } from "@cocalc/frontend/alerts";
import {
  AIAvatar,
  Icon,
  Paragraph,
  Text,
  Tooltip,
} from "@cocalc/frontend/components";
import { SiteName } from "@cocalc/frontend/customize";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import { labels } from "@cocalc/frontend/i18n";
import { useStudentProjectFunctionality } from "@cocalc/frontend/course/configuration/customize-student-project-functionality";
import { submitNavigatorPromptInWorkspaceChat } from "@cocalc/frontend/project/new/navigator-intents";
import { PopupAgentComposer } from "@cocalc/frontend/frame-editors/ai/popup-agent-composer";
import { useAgentAutoSubmit } from "@cocalc/frontend/frame-editors/ai/agent-auto-submit";
import {
  AgentSessionError,
  AgentSessionSelect,
  isNewAgentThreadSelection,
  usePersistentAgentSessionSelection,
} from "@cocalc/frontend/frame-editors/ai/agent-session-selector";

import { Kernel as KernelType } from "@cocalc/jupyter/util/misc";
import * as misc from "@cocalc/util/misc";
import {
  buildJupyterKernelAgentPrompt,
  POPULAR_JUPYTER_KERNEL_SPECS,
  type JupyterKernelInstallSpec,
} from "@cocalc/util/jupyter-kernel-installs";
import { COLORS } from "@cocalc/util/theme";
import { KernelStar } from "../components/run-button/kernel-star";
import { JupyterActions } from "./browser-actions";
import Logo from "./logo";

const MAIN_STYLE: CSS = {
  padding: "20px 10px",
  overflowY: "auto",
  overflowX: "hidden",
  background: COLORS.GRAY_LL,
} as const;

const SELECTION_STYLE: CSS = {
  marginTop: "2em",
} as const;

const ALL_LANGS_LABEL_STYLE: CSS = {
  fontWeight: "bold",
  color: COLORS.GRAY_D,
} as const;

const DEFAULT_JUPYTER_KERNEL_AGENT_MODEL = "gpt-5.4-mini";

interface KernelSelectorProps {
  actions: JupyterActions;
  embedded?: boolean;
  onSelectKernel?: (kernelName: string) => void;
}

interface KernelAgentInstallRequest {
  requestedKernel?: string;
  spec?: JupyterKernelInstallSpec;
}

function kernelAgentTargetKey(opts?: KernelAgentInstallRequest): string {
  const requested =
    `${opts?.spec?.requestedKernel ?? opts?.requestedKernel ?? ""}`.trim();
  return opts?.spec != null
    ? `popular:${opts.spec.key}`
    : requested || "generic";
}

function kernelInstallTagSuffix(opts: KernelAgentInstallRequest): string {
  const raw = `${opts.spec?.key ?? opts.requestedKernel ?? "generic"}`
    .trim()
    .toLowerCase();
  return raw.replace(/[^a-z0-9_.-]+/g, "-") || "generic";
}

function kernelInstallKernelLabel(opts: KernelAgentInstallRequest): string {
  return `${opts.spec?.label ?? opts.requestedKernel ?? ""}`.trim();
}

function kernelInstallVisiblePrompt(opts: KernelAgentInstallRequest): string {
  const label = kernelInstallKernelLabel(opts);
  return label
    ? `Install the ${label} Jupyter kernel.`
    : "Install a Jupyter kernel.";
}

function kernelInstallTitle(opts: KernelAgentInstallRequest): string {
  const label = kernelInstallKernelLabel(opts);
  return label ? `Install ${label} Jupyter kernel` : "Install Jupyter kernel";
}

function buildKernelInstallAgentPrompt({
  opts,
  notebookPath,
  userRequest,
}: {
  opts: KernelAgentInstallRequest;
  notebookPath: string;
  userRequest: string;
}): string {
  const requested =
    `${opts.spec?.requestedKernel ?? opts.requestedKernel ?? ""}`.trim();
  const prompt = buildJupyterKernelAgentPrompt({
    notebookPath,
    requestedKernel: requested,
    spec: opts.spec,
  });
  const request = userRequest.trim();
  return request ? `${prompt}\n\nUser request:\n${request}` : prompt;
}

export function KernelSelector({
  actions,
  embedded,
  onSelectKernel,
}: KernelSelectorProps) {
  const intl = useIntl();
  const sectionStyle: CSS = embedded ? { marginTop: "8px" } : SELECTION_STYLE;

  const editor_settings = useTypedRedux("account", "editor_settings");

  const redux_kernel: undefined | string = useRedux([actions.name, "kernel"]);
  const no_kernel = redux_kernel === "";
  // undefined and empty string are both treated as "null" aka "no kernel"
  const kernel = !redux_kernel ? null : redux_kernel;
  const default_kernel: undefined | string = useRedux([
    actions.name,
    "default_kernel",
  ]);
  const closestKernel: undefined | KernelType = useRedux([
    actions.name,
    "closestKernel",
  ]);
  const kernel_info: undefined | ImmutableMap<any, any> = useRedux([
    actions.name,
    "kernel_info",
  ]);
  const kernel_selection: undefined | ImmutableMap<string, string> = useRedux([
    actions.name,
    "kernel_selection",
  ]);
  const redux_project_id: undefined | string = useRedux([
    actions.name,
    "project_id",
  ]);
  const kernels_by_name:
    | undefined
    | OrderedMap<string, ImmutableMap<string, string>> = useRedux([
    actions.name,
    "kernels_by_name",
  ]);
  const kernels_by_language: undefined | OrderedMap<string, List<string>> =
    useRedux([actions.name, "kernels_by_language"]);
  const project_id = redux_project_id ?? actions.project_id;
  const accountCustomize = useTypedRedux("account", "customize");
  const accountOtherSettings = useTypedRedux("account", "other_settings");
  const studentProjectFunctionality =
    useStudentProjectFunctionality(project_id);
  const canAskAgentForKernel = useMemo(() => {
    if (!project_id) return false;
    return redux
      .getStore("projects")
      .isAIAllowedByPolicy(project_id, "jupyter-install-kernel");
  }, [
    accountCustomize,
    accountOtherSettings,
    project_id,
    studentProjectFunctionality.disableAI,
    studentProjectFunctionality.disableSomeAI,
  ]);
  const [sendingAgentInstall, setSendingAgentInstall] =
    useState<boolean>(false);
  const [pendingAgentInstall, setPendingAgentInstall] =
    useState<KernelAgentInstallRequest | null>(null);
  const [agentInstallPrompt, setAgentInstallPrompt] = useState<string>("");
  const [autoSubmit, setAutoSubmit] = useAgentAutoSubmit();
  const agentSessionSelection = usePersistentAgentSessionSelection({
    project_id: project_id ?? "",
    path: actions.path,
    cacheContext: "jupyter-install-kernel",
    enabled: pendingAgentInstall != null,
  });

  useEffect(() => {
    if (pendingAgentInstall == null) {
      setAgentInstallPrompt("");
      return;
    }
    setAgentInstallPrompt(kernelInstallVisiblePrompt(pendingAgentInstall));
  }, [pendingAgentInstall]);

  async function askAgentToInstallKernel(nextPrompt?: string) {
    if (!project_id || !canAskAgentForKernel) return;
    const opts = pendingAgentInstall ?? {};
    const visiblePrompt = `${nextPrompt ?? agentInstallPrompt}`.trim();
    if (!visiblePrompt || sendingAgentInstall) return;
    try {
      setSendingAgentInstall(true);
      const requested =
        `${opts.spec?.requestedKernel ?? opts.requestedKernel ?? ""}`.trim();
      const prompt = buildKernelInstallAgentPrompt({
        notebookPath: actions.path,
        opts,
        userRequest: visiblePrompt,
      });
      const title = kernelInstallTitle(opts);
      const tag = requested
        ? `intent:jupyter-install-kernel:${kernelInstallTagSuffix(opts)}`
        : "intent:jupyter-install-kernel";
      const createNewThread = isNewAgentThreadSelection(agentSessionSelection);
      const sent = await submitNavigatorPromptInWorkspaceChat({
        project_id,
        path: actions.path,
        prompt,
        visiblePrompt,
        title,
        tag,
        forceCodex: true,
        codexConfig: { model: DEFAULT_JUPYTER_KERNEL_AGENT_MODEL },
        openFloating: true,
        waitForAgent: false,
        agentSession: createNewThread
          ? undefined
          : agentSessionSelection.selectedAgentSession,
        createNewThread,
        submitToAgent: autoSubmit,
      });
      agentSessionSelection.saveSelectedAgentSession();
      if (!sent) {
        throw new Error("Unable to submit request to Agent.");
      }
      setPendingAgentInstall(null);
    } catch (err) {
      alert_message({
        type: "error",
        message: `Unable to ask Agent for help: ${err}`,
      });
    } finally {
      setSendingAgentInstall(false);
    }
  }

  function renderAskAgentButton(requestedKernel?: string): Rendered {
    if (!project_id || !canAskAgentForKernel) return;
    return (
      <Button
        size="small"
        onClick={() => setPendingAgentInstall({ requestedKernel })}
      >
        Agent
      </Button>
    );
  }

  function renderPopularKernelAgentButton(
    spec: JupyterKernelInstallSpec,
  ): Rendered {
    if (!project_id || !canAskAgentForKernel) return;
    return (
      <Button size="small" onClick={() => setPendingAgentInstall({ spec })}>
        Agent
      </Button>
    );
  }

  function render_popular_kernel_install_items(): Rendered[] {
    return POPULAR_JUPYTER_KERNEL_SPECS.map((spec) => (
      <Descriptions.Item key={`popular-kernel-${spec.key}`} label={spec.label}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: "12px",
            alignItems: "flex-start",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div>{spec.description}</div>
            <Text type="secondary" style={{ fontSize: "12px" }}>
              {spec.probeSummary}
            </Text>
          </div>
          {renderPopularKernelAgentButton(spec)}
        </div>
      </Descriptions.Item>
    ));
  }

  function render_install_kernel_items(): Rendered[] {
    if (!canAskAgentForKernel) return [];
    return [
      <Descriptions.Item key="install-generic-kernel" label="Ask Agent">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: "12px",
            alignItems: "flex-start",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div>Install any Jupyter kernel you need in this project.</div>
            <Text type="secondary" style={{ fontSize: "12px" }}>
              Agent will inspect the project environment, install the kernel,
              and register its kernelspec.
            </Text>
          </div>
          {renderAskAgentButton()}
        </div>
      </Descriptions.Item>,
      ...render_popular_kernel_install_items(),
    ];
  }

  function kernel_name(name: string): string | undefined {
    return kernel_attr(name, "display_name");
  }

  function kernel_attr(name: string, attr: string): string | undefined {
    if (kernels_by_name == null) return undefined;
    const k = kernels_by_name.get(name);
    if (k == null) return undefined;
    return k.get(attr, name);
  }

  function render_suggested_link(cocalc) {
    if (cocalc == null) return;
    const url: string | undefined = cocalc.get("url");
    const descr: string | undefined = cocalc.get("description", "");
    if (url != null) {
      return (
        <a href={url} target={"_blank"} rel={"noopener"}>
          {descr}
        </a>
      );
    } else {
      return descr;
    }
  }

  function render_kernel_button(name: string): Rendered {
    const lang = kernel_attr(name, "language");
    const priority: number = kernels_by_name
      ?.get(name)
      ?.getIn(["metadata", "cocalc", "priority"]) as number;
    const key = `kernel-${lang}-${name}`;
    const btn = (
      <Button
        key={key}
        size={embedded ? "small" : "middle"}
        onClick={() => {
          onSelectKernel?.(name);
          actions.select_kernel(name);
        }}
        style={{ height: embedded ? "28px" : "35px" }}
      >
        <Logo
          kernel={name}
          size={embedded ? 18 : 30}
          style={{
            marginTop: embedded ? "-1px" : "-2.5px",
            marginRight: "5px",
          }}
        />{" "}
        {kernel_name(name) || name}
        <KernelStar priority={priority} />
      </Button>
    );
    const cocalc = kernels_by_name?.getIn([name, "metadata", "cocalc"]);
    if (cocalc == null) {
      return btn;
    }
    return (
      <Tooltip key={key} color="white" title={render_suggested_link(cocalc)}>
        {btn}
      </Tooltip>
    );
  }

  function render_suggested() {
    if (kernel_selection == null || kernels_by_name == null) return;

    const entries: Rendered[] = [];
    const kbn = kernels_by_name;

    kernel_selection
      .sort((a, b) => {
        return -misc.cmp(
          kbn.getIn([a, "metadata", "cocalc", "priority"], 0),
          kbn.getIn([b, "metadata", "cocalc", "priority"], 0),
        );
      })
      .map((name, lang) => {
        const cocalc: ImmutableMap<string, any> = kbn.getIn(
          [name, "metadata", "cocalc"],
          null,
        ) as any;
        if (cocalc == null) return;
        const prio: number = cocalc.get("priority", 0);

        // drop those below 10, priority is too low
        if (prio < 10) return;

        const label = render_kernel_button(name);

        entries.push(
          <Descriptions.Item key={`${name}-${lang}`} label={label}>
            <div>{render_suggested_link(cocalc)}</div>
          </Descriptions.Item>,
        );
      });

    if (entries.length == 0) return;

    return (
      <Descriptions
        title="Suggested kernels"
        bordered
        column={1}
        style={sectionStyle}
      >
        {entries}
      </Descriptions>
    );
  }

  function render_no_kernels(): Rendered[] {
    return [
      <Descriptions.Item key="no_kernels" label={<Icon name="ban" />}>
        <Space orientation="vertical" size={8}>
          <Paragraph style={{ marginBottom: 0 }}>
            There are no kernels available. <SiteName /> searches the standard
            paths of Jupyter{" "}
            <Popover
              trigger={["click", "hover"]}
              content={
                <>
                  i.e. essentially <Text code>jupyter kernelspec list</Text>{" "}
                  going through{" "}
                  <Text code>jupyter --paths --json | jq .data</Text>
                </>
              }
            >
              <Icon
                style={{ color: COLORS.GRAY, cursor: "pointer" }}
                name="question-circle"
              />
            </Popover>{" "}
            for kernels.{" "}
            {canAskAgentForKernel
              ? "Install one of these common kernels with Agent, or ask Agent for a specific kernel."
              : "Install a Jupyter kernel in the project environment, then refresh this list."}
          </Paragraph>
        </Space>
      </Descriptions.Item>,
      ...render_install_kernel_items(),
    ];
  }

  function render_all_langs(): Rendered[] | undefined {
    if (kernels_by_language == null) return render_no_kernels();

    const all: Rendered[] = [];
    kernels_by_language.forEach((names, lang) => {
      const kernels = names.map((name) => render_kernel_button(name));

      const label = (
        <span style={ALL_LANGS_LABEL_STYLE}>{misc.capitalize(lang)}</span>
      );

      all.push(
        <Descriptions.Item key={lang} label={label}>
          {embedded ? (
            <Space size={[4, 4]} wrap>
              {kernels}
            </Space>
          ) : (
            <Space.Compact style={{ display: "flex", flexWrap: "wrap" }}>
              {kernels}
            </Space.Compact>
          )}
        </Descriptions.Item>,
      );
      return true;
    });

    if (all.length == 0) return render_no_kernels();

    return all;
  }

  function render_select_all() {
    const all = render_all_langs();
    const hasKnownKernels = (kernels_by_name?.size ?? 0) > 0;

    const items: TabsProps["items"] = [
      {
        key: "all",
        label: (
          <>
            <Icon name="jupyter" />{" "}
            {embedded ? "All Kernels" : "All kernels by language"}
          </>
        ),
        children: (
          <Descriptions bordered column={1} style={sectionStyle}>
            {all}
          </Descriptions>
        ),
      },
    ];
    if (hasKnownKernels && canAskAgentForKernel) {
      items.push({
        key: "install",
        label: (
          <>
            <Icon name="plus-circle" />{" "}
            {embedded ? "Install" : "Install kernels"}
          </>
        ),
        children: (
          <Descriptions bordered column={1} style={sectionStyle}>
            {render_install_kernel_items()}
          </Descriptions>
        ),
      });
    }

    return (
      <Tabs
        size={embedded ? "small" : "middle"}
        defaultActiveKey="all"
        items={items}
      />
    );
  }

  function render_last() {
    const name = default_kernel;
    if (name == null) return;
    if (kernels_by_name == null) return;
    // also don't render "last", if we do not know that kernel!
    if (!kernels_by_name.has(name)) return;
    if (editor_settings == null) return <Spin />;
    const ask_jupyter_kernel =
      editor_settings.get("ask_jupyter_kernel") ?? true;
    if (embedded) return;

    return (
      <Descriptions bordered column={1} style={sectionStyle}>
        <Descriptions.Item
          label={
            <FormattedMessage
              id="jupyter.select-kernel.quick-select.label"
              defaultMessage={"Quick select"}
            />
          }
        >
          <div
            style={{
              display: "grid",
              rowGap: "8px",
              alignItems: "start",
            }}
          >
            <Typography.Text
              style={{
                wordBreak: "normal",
                overflowWrap: "normal",
              }}
            >
              <FormattedMessage
                id="jupyter.select-kernel.quick-select.text"
                defaultMessage={"Your most recently selected kernel"}
                description={"Kernel in a Jupyter Notebook"}
              />
            </Typography.Text>
            <div>{render_kernel_button(name)}</div>
          </div>
        </Descriptions.Item>
        <Descriptions.Item
          label={
            <FormattedMessage
              id="jupyter.select-kernel.make-default.label"
              defaultMessage={"Make default"}
            />
          }
        >
          <Checkbox
            checked={!ask_jupyter_kernel}
            onChange={(e) => {
              dont_ask_again_click(e.target.checked);
            }}
          >
            <FormattedMessage
              id="jupyter.select-kernel.make-default.text"
              defaultMessage={
                "Do not ask again. Instead, default to your most recent selection."
              }
              description={"Kernel in a Jupyter Notebook"}
            />
          </Checkbox>
          <div>
            <Typography.Text type="secondary">
              <FormattedMessage
                id="jupyter.select-kernel.make-default.info"
                defaultMessage={
                  "You can always change the kernel by clicking on the kernel selector at the top right."
                }
                description={"Kernel in a Jupyter Notebook"}
              />
            </Typography.Text>
          </div>
        </Descriptions.Item>
      </Descriptions>
    );
  }

  function dont_ask_again_click(checked: boolean) {
    actions.kernel_dont_ask_again(checked);
  }

  function render_top() {
    if (embedded) {
      if (kernel == null || kernel_info == null) {
        return (
          <div style={{ marginBottom: "8px" }}>
            <Typography.Text type="secondary">
              {kernel == null
                ? "No kernel selected."
                : `Notebook kernel "${kernel}" is unavailable on this project.`}
            </Typography.Text>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {kernel == null && (
                <Button
                  size="small"
                  type={no_kernel ? "primary" : "default"}
                  onClick={() => actions.select_kernel("")}
                >
                  Continue without kernel
                </Button>
              )}
              {kernel != null ? renderAskAgentButton(kernel) : undefined}
            </div>
          </div>
        );
      }
      const name = kernel_name(kernel) ?? kernel;
      return (
        <Typography.Text type="secondary">
          Current kernel: {name}
        </Typography.Text>
      );
    }
    if (kernel == null || kernel_info == null) {
      let msg: Rendered;
      // kernel, but no info means it is not known
      if (kernel != null && kernel_info == null) {
        msg = (
          <>
            Your notebook kernel <code>"{kernel}"</code> does not exist on this
            project.
          </>
        );
      } else {
        msg = (
          <FormattedMessage
            id="jupyter.select-kernel.header.no-kernel"
            defaultMessage={"This notebook has no kernel."}
            description={"Kernel in a Jupyter Notebook"}
          />
        );
      }
      return (
        <Paragraph>
          <Text strong>{msg}</Text>{" "}
          <FormattedMessage
            id="jupyter.select-kernel.header.no-kernel-explanation"
            defaultMessage={
              "A working kernel is required in order to evaluate the code in the notebook. Please select one for the programming language you want to work with. Otherwise <Button>continue without a kernel</Button>."
            }
            description={"Kernel in a Jupyter Notebook"}
            values={{
              Button: (ch) => (
                <Button
                  size="small"
                  type={no_kernel ? "primary" : "default"}
                  onClick={() => actions.select_kernel("")}
                >
                  {ch}
                </Button>
              ),
            }}
          />
          {kernel != null ? (
            <div style={{ marginTop: "10px" }}>
              {renderAskAgentButton(kernel)}
            </div>
          ) : undefined}
        </Paragraph>
      );
    } else {
      const name = kernel_name(kernel);
      const current =
        name != null
          ? intl.formatMessage(
              {
                id: "jupyter.select-kernel.header.current",
                defaultMessage: `The currently selected kernel is "{name}".`,
                description: "Kernel in a Jupyter Notebook",
              },
              { name },
            )
          : "";

      return (
        <Paragraph>
          <Text strong>
            <FormattedMessage
              id="jupyter.select-kernel.header.message"
              defaultMessage={"Select a new kernel."}
              description={"Kernel in a Jupyter Notebook"}
            />
          </Text>{" "}
          {current}
        </Paragraph>
      );
    }
  }

  function render_unknown() {
    if (kernel_info != null || closestKernel == null) return;
    const closestKernelName = closestKernel.get("name");
    if (closestKernelName == null) return;

    return (
      <Descriptions
        bordered
        column={1}
        style={{
          backgroundColor: COLORS.ANTD_BG_RED_M,
          marginTop: embedded ? "8px" : undefined,
        }}
      >
        <Descriptions.Item label={"Unknown Kernel"}>
          <div style={{ display: "grid", gap: "10px" }}>
            <div>
              A similar kernel might be{" "}
              {render_kernel_button(closestKernelName)}.
            </div>
            {renderAskAgentButton(kernel ?? closestKernelName)}
          </div>
        </Descriptions.Item>
      </Descriptions>
    );
  }

  function render_footer(): Rendered {
    if (embedded) {
      return;
    }
    return (
      <div style={{ color: COLORS.GRAY, paddingBottom: "2em" }}>
        <Paragraph>
          <FormattedMessage
            id="jupyter.select_kernel.footer"
            defaultMessage="<strong>Note:</strong> You can always change the selected kernel later in the Kernel menu or by clicking on the kernel status logo in the top left."
            description="Jupyter kernel selector, bottom."
            values={{
              strong: (c) => <Text strong>{c}</Text>,
            }}
          />
        </Paragraph>
      </div>
    );
  }

  function renderCloseButton(): Rendered | undefined {
    if (embedded) {
      return;
    }
    return (
      <Button
        style={{ marginRight: "5px" }}
        onClick={() => actions.hide_select_kernel()}
      >
        Close
      </Button>
    );
  }

  const [refreshingKernels, setRefreshingKernels] = useState<boolean>(false);
  function renderRefreshButton(): Rendered | undefined {
    // Keep refresh available when kernel/kernel_info are missing or unknown:
    // those are precisely the cases where forcing a kernel list reload helps.
    const loading = refreshingKernels;
    return (
      <Button
        size={embedded ? "small" : "middle"}
        disabled={loading}
        onClick={async () => {
          try {
            setRefreshingKernels(true);
            await actions.fetch_jupyter_kernels({
              noCache: true,
              autostart: true,
            });
          } finally {
            setRefreshingKernels(false);
          }
        }}
      >
        <Icon name="refresh" spin={loading} /> Refresh
      </Button>
    );
  }

  function renderAgentInstallModal(): Rendered {
    if (!canAskAgentForKernel) return;
    const opts = pendingAgentInstall ?? {};
    const title = kernelInstallTitle(opts);
    const createNewThread = isNewAgentThreadSelection(agentSessionSelection);
    const helperText = createNewThread
      ? "The agent will start a new workspace thread with fresh context."
      : agentSessionSelection.selectedAgentSession
        ? "The agent will continue in the selected session."
        : "The agent will continue in the workspace agent thread.";
    return (
      <Modal
        title={
          <Space size="small">
            <AIAvatar size={18} />
            <span>Install Jupyter Kernel with Agent</span>
          </Space>
        }
        open={pendingAgentInstall != null}
        onCancel={() => {
          if (!sendingAgentInstall) {
            setPendingAgentInstall(null);
          }
        }}
        destroyOnHidden
        footer={null}
        width={560}
        mask={{ closable: !sendingAgentInstall }}
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <div style={{ color: COLORS.GRAY_D }}>
            Agent will inspect this project environment, install the requested
            Jupyter kernel, and register its kernelspec when it can do so
            safely. You can edit the request before sending.
          </div>
          <div>
            Request: <Text strong>{title}</Text>
          </div>
          <AgentSessionSelect
            selection={agentSessionSelection}
            disabled={sendingAgentInstall}
            includeNewThreadOption
          />
          <AgentSessionError selection={agentSessionSelection} />
          <PopupAgentComposer
            value={agentInstallPrompt}
            onChange={setAgentInstallPrompt}
            onSubmit={(value) => void askAgentToInstallKernel(value)}
            placeholder="Describe the Jupyter kernel Agent should install..."
            cacheId={`popup-agent:jupyter-install-kernel:${project_id}:${actions.path}:${kernelAgentTargetKey(opts)}`}
            autoFocus
          />
          <div style={{ color: COLORS.GRAY_D }}>{helperText}</div>
          <div
            style={{
              alignItems: "center",
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <Checkbox
              checked={autoSubmit}
              disabled={sendingAgentInstall}
              onChange={(event) => setAutoSubmit(event.target.checked)}
            >
              Automatically submit to Agent
            </Checkbox>
            <Space>
              <Button
                disabled={sendingAgentInstall}
                onClick={() => setPendingAgentInstall(null)}
              >
                {intl.formatMessage(labels.cancel)}
              </Button>
              <Button
                type="primary"
                disabled={sendingAgentInstall || !agentInstallPrompt.trim()}
                onClick={() => void askAgentToInstallKernel()}
              >
                <Icon
                  name={sendingAgentInstall ? "spinner" : "paper-plane"}
                  spin={sendingAgentInstall}
                />{" "}
                Send
              </Button>
            </Space>
          </div>
        </Space>
      </Modal>
    );
  }

  function render_body(): Rendered {
    if (kernels_by_name == null || kernel_selection == null) {
      return (
        <div>
          {render_top()}
          <Spin />
        </div>
      );
    } else {
      if (embedded) {
        return (
          <>
            {render_top()}
            {render_unknown()}
            {render_select_all()}
          </>
        );
      }
      return (
        <>
          {render_top()}
          {render_unknown()}
          {render_last()}
          {render_suggested()}
          {render_select_all()}
          <hr />
          {render_footer()}
        </>
      );
    }
  }

  function render_head(): Rendered {
    if (embedded) {
      return (
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            marginBottom: "4px",
          }}
        >
          {renderRefreshButton()}
        </div>
      );
    }
    return (
      <div>
        <div style={{ float: "right", display: "flex", alignItems: "center" }}>
          {renderCloseButton()}
          {renderRefreshButton()}
        </div>
        <h3 style={{ marginTop: 0 }}>
          {intl.formatMessage(labels.select_a_kernel)}
        </h3>
      </div>
    );
  }

  function checkObvious(): boolean {
    const name = closestKernel?.get("name");
    if (!name) return false;
    if (kernel != "sagemath") return false;
    // just do it -- this happens when automatically converting
    // a legacy worksheet to a notebook.
    setTimeout(() => actions.select_kernel(name), 0);
    return true;
  }

  if (!embedded && IS_MOBILE) {
    /*
NOTE: I tried viewing this on mobile and it is so HORRIBLE!
Something about the CSS and Typography components are just truly
a horrific disaster.  This one component though is maybe usable.
*/
    return (
      <>
        {renderAgentInstallModal()}
        <div
          style={{
            overflow: "auto",
            padding: "20px 10px",
          }}
          className={"smc-vfill"}
        >
          <div style={{ float: "right" }}>
            {renderCloseButton()}
            {renderRefreshButton()}
          </div>
          {render_select_all()}
        </div>
      </>
    );
  }

  if (checkObvious()) {
    // avoid flicker displaying big error.
    return null;
  }
  if (embedded) {
    return (
      <>
        {renderAgentInstallModal()}
        <div style={{ padding: "0 4px 12px 4px" }}>
          {render_head()}
          {render_body()}
        </div>
      </>
    );
  }
  return (
    <>
      {renderAgentInstallModal()}
      <div style={MAIN_STYLE} className={"smc-vfill"}>
        <Card
          title={render_head()}
          style={{ margin: "0 auto", maxWidth: "900px" }}
        >
          {render_body()}
        </Card>
      </div>
    </>
  );
}
