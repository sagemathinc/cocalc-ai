/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Col, Row, Space } from "antd";
import { FormattedMessage } from "react-intl";

import useAppContext from "@cocalc/frontend/app/use-context";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, Title } from "@cocalc/frontend/components";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { StartButton } from "@cocalc/frontend/project/start-button";
import { getProjectLifecycleDisplayState } from "@cocalc/frontend/projects/host-operational";
import { ProjectTitle } from "@cocalc/frontend/projects/project-title";
import { COLORS } from "@cocalc/util/theme";
import { FIXED_PROJECT_TABS } from "../file-tab";
import { AGENT_CHAT_MAX_WIDTH_PX } from "../agent-layout-constants";
import { NavigatorShell } from "../../new/navigator-shell";
import { HomeRecentFiles } from "./recent-files";

const BTN_PROPS = {
  block: true,
  width: "50%",
  size: "large",
  style: { backgroundColor: COLORS.GRAY_LLL },
  overflow: "hidden",
} as const;

export default function HomePage() {
  const { displayI18N: display } = useAppContext();
  const { project_id, actions } = useProjectContext();
  const other_settings = useTypedRedux("account", "other_settings");
  const project_map = useTypedRedux("projects", "project_map");
  const lifecycleState = getProjectLifecycleDisplayState({
    projectState: project_map?.getIn([project_id, "state", "state"]),
    lastBackup: project_map?.getIn([project_id, "last_backup"]),
  });
  const navigator_target_project_id = other_settings?.get?.(
    "navigator_target_project_id",
  );
  const projectLabelLower = "project";
  const showLifecycleBanner = lifecycleState !== "running";

  return (
    <Row
      gutter={[30, 30]}
      style={{
        maxWidth: AGENT_CHAT_MAX_WIDTH_PX,
        margin: "0 auto",
        padding: "10px",
      }}
    >
      <Col md={24}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Title
            level={2}
            onClick={() => actions?.set_active_tab("settings")}
            style={{
              cursor: "pointer",
              textAlign: "center",
              color: COLORS.GRAY_M,
            }}
          >
            <ProjectTitle project_id={project_id} noClick />
          </Title>
        </div>
      </Col>
      {showLifecycleBanner ? (
        <Col md={24}>
          <Alert
            type="info"
            showIcon
            message={
              lifecycleState === "archived"
                ? `This ${projectLabelLower} is archived.`
                : lifecycleState === "new"
                  ? `This ${projectLabelLower} is new.`
                  : `This ${projectLabelLower} is not running.`
            }
            description={
              <div>
                {lifecycleState === "archived" ? (
                  <FormattedMessage
                    id="project.home.archived_project.warning"
                    defaultMessage={
                      "Archived projects do not count toward active storage. <a>Start this project</a> to restore it from backup and make the filesystem available again. Once restored, it will count toward your global storage quota."
                    }
                    values={{
                      a: (chunks) => (
                        <a
                          onClick={(e) => {
                            e.preventDefault();
                            redux
                              .getActions("projects")
                              .start_project(project_id);
                          }}
                        >
                          {chunks}
                        </a>
                      ),
                    }}
                  />
                ) : lifecycleState === "new" ? (
                  <FormattedMessage
                    id="project.home.new_project.warning"
                    defaultMessage={
                      "This project has not been provisioned yet. <a>Start this project</a> to create the filesystem and make files available."
                    }
                    values={{
                      a: (chunks) => (
                        <a
                          onClick={(e) => {
                            e.preventDefault();
                            redux
                              .getActions("projects")
                              .start_project(project_id);
                          }}
                        >
                          {chunks}
                        </a>
                      ),
                    }}
                  />
                ) : (
                  <FormattedMessage
                    id="project.home.stopped_project.warning"
                    defaultMessage={
                      "<a>Start this project</a> to make the filesystem available again."
                    }
                    values={{
                      a: (chunks) => (
                        <a
                          onClick={(e) => {
                            e.preventDefault();
                            redux
                              .getActions("projects")
                              .start_project(project_id);
                          }}
                        >
                          {chunks}
                        </a>
                      ),
                    }}
                  />
                )}
                <div style={{ marginTop: "12px" }}>
                  <StartButton project_id={project_id} />
                </div>
              </div>
            }
          />
        </Col>
      ) : (
        <>
          <Col md={24}>
            <NavigatorShell
              project_id={project_id}
              defaultTargetProjectId={
                typeof navigator_target_project_id === "string"
                  ? navigator_target_project_id
                  : undefined
              }
            />
          </Col>
          <Col md={24} style={{ textAlign: "center" }}>
            <Space.Compact>
              <Button
                {...BTN_PROPS}
                onClick={() => {
                  actions?.set_active_tab("new");
                }}
              >
                <Icon name={FIXED_PROJECT_TABS.new.icon} /> Create a new file
                ...
              </Button>
              <Button
                {...BTN_PROPS}
                onClick={() => {
                  actions?.set_active_tab("files");
                }}
              >
                <Icon name={FIXED_PROJECT_TABS.files.icon} /> Browse existing
                files ...
              </Button>
            </Space.Compact>
          </Col>
          <Col md={24} style={{ textAlign: "center" }}>
            <Button type="text" onClick={() => actions?.set_active_tab("log")}>
              <Icon name={FIXED_PROJECT_TABS.log.icon} />{" "}
              {display(FIXED_PROJECT_TABS.log.label)}
            </Button>
            <Button
              type="text"
              onClick={() => actions?.set_active_tab("users")}
            >
              <Icon name={FIXED_PROJECT_TABS.users.icon} />{" "}
              {display(FIXED_PROJECT_TABS.users.label)}
            </Button>
            <Button
              type="text"
              onClick={() => actions?.set_active_tab("settings")}
            >
              <Icon name={FIXED_PROJECT_TABS.settings.icon} />{" "}
              {display(FIXED_PROJECT_TABS.settings.label)}
            </Button>
          </Col>
          <Col md={24}>
            <HomeRecentFiles
              project_id={project_id}
              style={{ height: "max(200px, 50%)" }}
              mode="embed"
            />
          </Col>
        </>
      )}
    </Row>
  );
}
