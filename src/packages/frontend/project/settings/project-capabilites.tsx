/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { ReloadOutlined } from "@ant-design/icons";
import { Button, Space } from "antd";
import { keys, sortBy } from "lodash";
import React from "react";

import { Rendered, redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, Loading, SettingBox } from "@cocalc/frontend/components";
import { alert_message } from "@cocalc/frontend/alerts";
import { submitNavigatorPromptInWorkspaceChat } from "@cocalc/frontend/project/new/navigator-intents";
import { tool2display } from "@cocalc/util/code-formatter";
import * as misc from "@cocalc/util/misc";
import {
  buildFormatterAgentPrompt,
  buildProjectCapabilityAgentPrompt,
  PROJECT_CAPABILITY_SPECS,
} from "@cocalc/util/project-capabilities";
import { COLORS } from "@cocalc/util/theme";
import { Project } from "./types";

declare let DEBUG;

interface ReactProps {
  project: Project;
  project_id: string;
  mode?: "project" | "flyout";
}

const LIST_STYLE: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "20px minmax(0, 1fr)",
  columnGap: "10px",
  rowGap: "10px",
  alignItems: "start",
};

const SECTION_TITLE_STYLE: React.CSSProperties = {
  fontSize: "16px",
  fontWeight: 600,
  margin: "0 0 12px 0",
};

const SECTION_STYLE: React.CSSProperties = {
  display: "grid",
  gap: "18px",
};

export const ProjectCapabilities: React.FC<ReactProps> = React.memo(
  (props: ReactProps) => {
    const { project, project_id, mode = "project" } = props;
    const [sendingAgentTarget, setSendingAgentTarget] = React.useState<
      string | null
    >(null);

    const available_features = useTypedRedux(
      { project_id },
      "available_features",
    );
    const configuration_loading = useTypedRedux(
      { project_id },
      "configuration_loading",
    );
    const configuration = useTypedRedux({ project_id }, "configuration");

    async function sendInstallPrompt(opts: {
      key: string;
      title: string;
      prompt: string;
      visiblePrompt: string;
      tag: string;
    }): Promise<void> {
      try {
        setSendingAgentTarget(opts.key);
        const sent = await submitNavigatorPromptInWorkspaceChat({
          project_id,
          prompt: opts.prompt,
          visiblePrompt: opts.visiblePrompt,
          title: opts.title,
          tag: opts.tag,
          forceCodex: true,
          openFloating: true,
          waitForAgent: false,
        });
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
          current === opts.key ? null : current,
        );
      }
    }

    function renderAgentButton(opts: {
      available: boolean;
      key: string;
      title: string;
      prompt: string;
      visiblePrompt: string;
      tag: string;
    }): Rendered {
      if (opts.available) {
        return undefined;
      }
      return (
        <Button
          size="small"
          loading={sendingAgentTarget === opts.key}
          onClick={() => void sendInstallPrompt(opts)}
        >
          Agent
        </Button>
      );
    }

    function render_features(avail): [Rendered, boolean] {
      const features: React.JSX.Element[] = [];
      let any_nonavail = false;
      for (const spec of Array.from(
        sortBy(PROJECT_CAPABILITY_SPECS, (feature) => feature.label),
      )) {
        const { key, label: display } = spec;
        const available = avail[key];
        any_nonavail = !available;
        const color = available ? COLORS.BS_GREEN_D : COLORS.BS_RED;
        const icon = available ? "check-square" : "minus-square";
        let extra = "";
        if (key == "sage") {
          const main = configuration?.get("main");
          const sage_version = main?.capabilities?.sage_version;
          if (sage_version != null && Array.isArray(sage_version)) {
            extra = `(version ${sage_version.join(".")})`;
          }
        }
        features.push(
          <React.Fragment key={key}>
            <div>
              <Icon name={icon} style={{ color }} />
            </div>
            <div>
              <Space
                size={8}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  width: "100%",
                }}
              >
                <span>
                  {display} {extra}
                </span>
                {renderAgentButton({
                  available,
                  key: `feature:${key}`,
                  title: `Install ${display}`,
                  visiblePrompt: `Install ${display}`,
                  tag: `intent:project-capability:${key}`,
                  prompt: buildProjectCapabilityAgentPrompt(spec),
                })}
              </Space>
            </div>
          </React.Fragment>,
        );
      }

      const component = <div style={LIST_STYLE}>{features}</div>;
      return [component, any_nonavail];
    }

    function render_formatter(formatter): [Rendered, boolean] {
      if (formatter === false) {
        return [<div>No code formatters are available</div>, true];
      }
      if (formatter === true) {
        return [<div>All code formatters are available</div>, false];
      }

      const r_formatters: React.JSX.Element[] = [];
      let any_nonavail = false;
      for (const tool of sortBy(keys(formatter), (x) => x)) {
        const available = formatter[tool];
        const color = available ? COLORS.BS_GREEN_D : COLORS.BS_RED;
        const icon = available ? "check-square" : "minus-square";
        const langs = tool2display[tool];
        // only tell users about tools where we know what for they're used
        if (langs == null || langs.length === 0) {
          continue;
        }
        // only consider availiability after eventually ignoring a specific tool,
        // because it will not show up in the UI
        any_nonavail = !available;

        r_formatters.push(
          <React.Fragment key={tool}>
            <div>
              <Icon name={icon} style={{ color }} />{" "}
            </div>
            <div>
              <Space
                size={8}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  width: "100%",
                }}
              >
                <span>
                  <b>{tool}</b> for {misc.to_human_list(langs)}
                </span>
                {renderAgentButton({
                  available,
                  key: `formatter:${tool}`,
                  title: `Install formatter ${tool}`,
                  visiblePrompt: `Install formatter ${tool}`,
                  tag: `intent:project-formatter:${tool}`,
                  prompt: buildFormatterAgentPrompt({
                    tool,
                    languages: langs,
                  }),
                })}
              </Space>
            </div>
          </React.Fragment>,
        );
      }

      const component = (
        <>
          {render_debug_info(formatter)}
          <div style={LIST_STYLE}>{r_formatters}</div>
        </>
      );
      return [component, any_nonavail];
    }

    function render_available(): Rendered {
      const avail = available_features?.toJS();
      if (avail == undefined) {
        return (
          <div>
            Information about available features will show up here.
            <br />
            {configuration_loading ? <Loading /> : undefined}
          </div>
        );
      }

      const [features] = render_features(avail);
      const [formatter] = render_formatter(avail.formatting);

      return (
        <div
          style={{
            ...SECTION_STYLE,
            gridTemplateColumns:
              mode === "project" ? "repeat(2, minmax(0, 1fr))" : undefined,
            alignItems: "start",
          }}
        >
          <section>
            <h3 style={SECTION_TITLE_STYLE}>Available Features</h3>
            {features}
          </section>
          <section>
            <h3 style={SECTION_TITLE_STYLE}>Available Formatters</h3>
            {formatter}
          </section>
        </div>
      );
    }

    function render_debug_info(conf): Rendered {
      if (conf != null && DEBUG) {
        return (
          <pre style={{ fontSize: "9px", color: "black" }}>
            {JSON.stringify(conf, undefined, 2)}
          </pre>
        );
      }
    }

    function reload(): void {
      const project_id = project.get("project_id");
      const pa = redux.getProjectActions(project_id);
      pa.reload_configuration();
    }

    function render_reload(): Rendered {
      return (
        <Button
          onClick={() => reload()}
          icon={<ReloadOutlined />}
          disabled={configuration_loading}
        >
          Refresh
        </Button>
      );
    }

    function render_title(): Rendered {
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
            width: "100%",
          }}
        >
          <span>Features and Configuration</span>
          {render_reload()}
        </div>
      );
    }

    const conf = configuration;

    if (mode === "flyout") {
      return (
        <>
          {render_debug_info(conf)}
          {render_available()}
        </>
      );
    } else {
      return (
        <SettingBox title={render_title()} icon={"clipboard-check"}>
          {render_debug_info(conf)}
          {render_available()}
        </SettingBox>
      );
    }
  },
  dont_render,
);

function dont_render(prev, next) {
  return !misc.is_different(prev, next, [
    "project",
    "configuration",
    "configuration_loading",
    "available_features",
  ]);
}
