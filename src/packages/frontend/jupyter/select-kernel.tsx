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
  useRedux,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { useState } from "react";
import { alert_message } from "@cocalc/frontend/alerts";
import { Icon, Paragraph, Text, Tooltip } from "@cocalc/frontend/components";
import { SiteName } from "@cocalc/frontend/customize";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import { labels } from "@cocalc/frontend/i18n";
import {
  submitNavigatorPromptInWorkspaceChat,
  submitNavigatorPromptToCurrentThread,
} from "@cocalc/frontend/project/new/navigator-intents";
import track from "@cocalc/frontend/user-tracking";
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

interface KernelSelectorProps {
  actions: JupyterActions;
  embedded?: boolean;
  onSelectKernel?: (kernelName: string) => void;
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
  const [sendingAgentTarget, setSendingAgentTarget] = useState<string | null>(
    null,
  );

  function kernelInstallTagSuffix(opts: {
    requestedKernel?: string;
    spec?: JupyterKernelInstallSpec;
  }): string {
    const raw = `${opts.spec?.key ?? opts.requestedKernel ?? "generic"}`
      .trim()
      .toLowerCase();
    return raw.replace(/[^a-z0-9_.-]+/g, "-") || "generic";
  }

  function kernelInstallVisiblePrompt(opts: {
    requestedKernel?: string;
    spec?: JupyterKernelInstallSpec;
  }): string {
    if (opts.spec != null) {
      return `Install ${opts.spec.label}`;
    }
    const requested = `${opts.requestedKernel ?? ""}`.trim();
    return requested
      ? `Install Jupyter kernel ${requested}`
      : "Install a Jupyter kernel";
  }

  function kernelInstallTitle(opts: {
    requestedKernel?: string;
    spec?: JupyterKernelInstallSpec;
  }): string {
    if (opts.spec != null) {
      return `Install ${opts.spec.label}`;
    }
    const requested = `${opts.requestedKernel ?? ""}`.trim();
    return requested
      ? `Install Jupyter kernel ${requested}`
      : "Install Jupyter kernel";
  }

  async function askAgentToInstallKernel(opts?: {
    requestedKernel?: string;
    spec?: JupyterKernelInstallSpec;
  }) {
    if (!project_id) return;
    try {
      const requested =
        `${opts?.spec?.requestedKernel ?? opts?.requestedKernel ?? ""}`.trim();
      const targetKey =
        opts?.spec != null
          ? `popular:${opts.spec.key}`
          : requested || "generic";
      setSendingAgentTarget(targetKey);
      const prompt = buildJupyterKernelAgentPrompt({
        notebookPath: actions.path,
        requestedKernel: requested,
        spec: opts?.spec,
      });
      const visiblePrompt = kernelInstallVisiblePrompt(opts ?? {});
      const title = kernelInstallTitle(opts ?? {});
      const tag = requested
        ? `intent:jupyter-install-kernel:${kernelInstallTagSuffix(opts ?? {})}`
        : "intent:jupyter-install-kernel";
      let sent = await submitNavigatorPromptInWorkspaceChat({
        project_id,
        path: actions.path,
        prompt,
        visiblePrompt,
        title,
        tag,
        forceCodex: true,
        openFloating: true,
        waitForAgent: false,
      });
      if (!sent) {
        sent = await submitNavigatorPromptToCurrentThread({
          project_id,
          path: actions.path,
          prompt,
          visiblePrompt,
          title,
          tag,
          forceCodex: true,
          openFloating: true,
          createNewThread: true,
        });
      }
      if (!sent) {
        throw new Error("Unable to submit request to Agent.");
      }
    } catch (err) {
      alert_message({
        type: "error",
        message: `Unable to ask Agent for help: ${err}`,
      });
    } finally {
      setSendingAgentTarget((current) =>
        current ===
        (opts?.spec != null
          ? `popular:${opts.spec.key}`
          : `${opts?.requestedKernel ?? ""}`.trim() || "generic")
          ? null
          : current,
      );
    }
  }

  function renderAskAgentButton(requestedKernel?: string): Rendered {
    if (!project_id) return;
    const targetKey = `${requestedKernel ?? ""}`.trim() || "generic";
    return (
      <Button
        size="small"
        loading={sendingAgentTarget === targetKey}
        onClick={() => void askAgentToInstallKernel({ requestedKernel })}
      >
        Agent
      </Button>
    );
  }

  function renderPopularKernelAgentButton(
    spec: JupyterKernelInstallSpec,
  ): Rendered {
    if (!project_id) return;
    return (
      <Button
        size="small"
        loading={sendingAgentTarget === `popular:${spec.key}`}
        onClick={() => void askAgentToInstallKernel({ spec })}
      >
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
          track("jupyter", {
            action: "select-kernel",
            kernel: name,
            how: "click-button-in-dialog",
          });
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
        <Space direction="vertical" size={8}>
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
            for kernels. Install one of these common kernels with Agent, or ask
            Agent for a specific kernel.
          </Paragraph>
        </Space>
      </Descriptions.Item>,
      ...render_popular_kernel_install_items(),
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

    return (
      <Tabs
        size={embedded ? "small" : "middle"}
        defaultActiveKey="all"
        items={items}
        onTabClick={(key) => {
          track("jupyter-selector", { action: "tab-click", tab: key });
        }}
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
              track("jupyter", {
                action: "dont_ask_kernel",
                dont_ask: e.target.checked,
              });
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
            await actions.fetch_jupyter_kernels({ noCache: true });
          } finally {
            setRefreshingKernels(false);
          }
        }}
      >
        <Icon name="refresh" spin={loading} /> Refresh
      </Button>
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
    );
  }

  if (checkObvious()) {
    // avoid flicker displaying big error.
    return null;
  }
  if (embedded) {
    return (
      <div style={{ padding: "0 4px 12px 4px" }}>
        {render_head()}
        {render_body()}
      </div>
    );
  }
  return (
    <div style={MAIN_STYLE} className={"smc-vfill"}>
      <Card
        title={render_head()}
        style={{ margin: "0 auto", maxWidth: "900px" }}
      >
        {render_body()}
      </Card>
    </div>
  );
}
