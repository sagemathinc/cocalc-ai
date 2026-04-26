/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { ReloadOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { keys, sortBy } from "lodash";
import React from "react";

import { Rendered, redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, Loading, SettingBox } from "@cocalc/frontend/components";
import { tool2display } from "@cocalc/util/code-formatter";
import { R_IDE } from "@cocalc/util/consts/ui";
import * as misc from "@cocalc/util/misc";
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

    const available_features = useTypedRedux(
      { project_id },
      "available_features",
    );
    const configuration_loading = useTypedRedux(
      { project_id },
      "configuration_loading",
    );
    const configuration = useTypedRedux({ project_id }, "configuration");

    function render_features(avail): [Rendered, boolean] {
      const feature_map = [
        ["spellcheck", "Spellchecking"],
        ["rmd", "RMarkdown"],
        ["qmd", "Quarto"],
        ["sage", "SageMath"],
        ["jupyter_notebook", "Classical Jupyter Notebook"],
        ["jupyter_lab", "Jupyter Lab"],
        ["x11", "Graphical Linux applications (X11 Desktop)"],
        ["latex", "LaTeX editor"],
        ["html2pdf", "HTML to PDF via Chrome/Chromium"],
        ["pandoc", "File format conversions via pandoc"],
        ["vscode", "VSCode editor"],
        ["julia", "Julia programming language"],
        ["rserver", R_IDE],
      ];
      const features: React.JSX.Element[] = [];
      let any_nonavail = false;
      for (const [key, display] of Array.from(
        sortBy(feature_map, (f) => f[1]),
      )) {
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
              {display} {extra}
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
              <b>{tool}</b> for {misc.to_human_list(langs)}
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
        <div style={SECTION_STYLE}>
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
