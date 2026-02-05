/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Col, Modal, Row } from "antd";
import { Gutter } from "antd/es/grid/row";
import { useState } from "@cocalc/frontend/app-framework";
import { HelpEmailLink } from "@cocalc/frontend/customize";
import { useStudentProjectFunctionality } from "@cocalc/frontend/course";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { R_IDE } from "@cocalc/util/consts/ui";
import { NamedServerName } from "@cocalc/util/types/servers";
import { NamedServerPanel } from "../named-server-panel";
import { NewFileButton } from "../new/new-file-button";

// Antd's 24 grid system
const md = 6;
const sm = 12;
const y: Gutter = 30;
const gutter: [Gutter, Gutter] = [20, y / 2];
const newRowStyle = { marginTop: `${y}px` };

export function ProjectServerTiles({
  visibleApps,
}: {
  visibleApps?: NamedServerName[];
}) {
  const { project_id } = useProjectContext();
  const student_project_functionality =
    useStudentProjectFunctionality(project_id);
  const [showNamedServer, setShowNamedServer] = useState<"" | NamedServerName>(
    "",
  );

  function toggleShowNamedServer(name: NamedServerName): void {
    showNamedServer == name ? setShowNamedServer("") : setShowNamedServer(name);
  }

  function isVisible(name: NamedServerName): boolean {
    return visibleApps == null || visibleApps.includes(name);
  }

  const serversDisabled: boolean =
    !!student_project_functionality.disableJupyterLabServer &&
    !!student_project_functionality.disableJupyterClassicServer &&
    !!student_project_functionality.disableVSCodeServer &&
    !!student_project_functionality.disablePlutoServer &&
    !!student_project_functionality.disableRServer;

  return (
    <>
      <Row gutter={gutter} style={newRowStyle}>
        {!student_project_functionality.disableJupyterLabServer &&
          isVisible("jupyterlab") && (
          <Col sm={sm} md={md}>
            <NewFileButton
              name={<span style={{ fontSize: "14pt" }}>JupyterLab</span>}
              icon={"ipynb"}
              active={showNamedServer === "jupyterlab"}
              on_click={() => toggleShowNamedServer("jupyterlab")}
            />
          </Col>
        )}
        {!student_project_functionality.disableVSCodeServer &&
          isVisible("code") && (
          <Col sm={sm} md={md}>
            <NewFileButton
              name={<span style={{ fontSize: "14pt" }}>VS Code</span>}
              icon={"vscode"}
              active={showNamedServer === "code"}
              on_click={() => toggleShowNamedServer("code")}
            />
          </Col>
        )}
        {!student_project_functionality.disablePlutoServer &&
          isVisible("pluto") && (
          <Col sm={sm} md={md}>
            <NewFileButton
              name={<span style={{ fontSize: "14pt" }}>Pluto (Julia)</span>}
              icon={"julia"}
              active={showNamedServer === "pluto"}
              on_click={() => toggleShowNamedServer("pluto")}
            />
          </Col>
        )}
        {!student_project_functionality.disableRServer &&
          isVisible("rserver") && (
          <Col sm={sm} md={md}>
            <NewFileButton
              name={<span style={{ fontSize: "14pt" }}>{R_IDE}</span>}
              icon={"r"}
              active={showNamedServer === "rserver"}
              on_click={() => toggleShowNamedServer("rserver")}
            />
          </Col>
        )}
        {!student_project_functionality.disableJupyterClassicServer &&
          isVisible("jupyter") && (
          <Col sm={sm} md={md}>
            <NewFileButton
              name={<span style={{ fontSize: "14pt" }}>Jupyter Classic</span>}
              icon={"ipynb"}
              active={showNamedServer === "jupyter"}
              on_click={() => toggleShowNamedServer("jupyter")}
            />
          </Col>
        )}
        {serversDisabled && (
          <Col sm={sm} md={md}>
            <NewFileButton
              name={"Servers disabled"}
              icon={"exclamation-circle"}
              on_click={() =>
                Modal.info({
                  title: "Servers disabled",
                  content: (
                    <>
                      App servers are disabled in this project. You can{" "}
                      <HelpEmailLink text="ask an administrator" /> to enable
                      them.
                    </>
                  ),
                })
              }
            />
          </Col>
        )}
      </Row>

      <div>
        {showNamedServer && (
          <NamedServerPanel
            project_id={project_id}
            name={showNamedServer}
            style={{ maxWidth: "1200px", margin: "30px auto" }}
          />
        )}
      </div>
    </>
  );
}
