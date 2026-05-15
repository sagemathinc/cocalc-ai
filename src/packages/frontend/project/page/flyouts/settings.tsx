/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Collapse, CollapseProps, Space } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useIntl } from "react-intl";
import {
  useEffect,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import {
  Icon,
  IconName,
  Loading,
  Title,
  Tooltip,
} from "@cocalc/frontend/components";
import { IntlMessage, isIntlMessage } from "@cocalc/frontend/i18n";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { RestartProject } from "@cocalc/frontend/project/settings/restart-project";
import MoveProject from "@cocalc/frontend/project/settings/move-project";
import { StopProject } from "@cocalc/frontend/project/settings/stop-project";
import { COMPUTE_STATES } from "@cocalc/util/compute-states";
import { DATASTORE_TITLE } from "@cocalc/util/db-schema/site-defaults";
import { FLYOUT_PADDING } from "./consts";
import { getFlyoutSettings, storeFlyoutState } from "./state";
import ProjectControlError from "@cocalc/frontend/project/settings/project-control-error";
import { normalizeProjectStateForDisplay } from "@cocalc/frontend/projects/host-operational";
import { useProjectSettingsSections } from "@cocalc/frontend/project/settings/sections";

interface Props {
  project_id: string;
  wrap: (content: React.JSX.Element) => React.JSX.Element;
}

export function SettingsFlyout(_: Readonly<Props>): React.JSX.Element {
  const { project_id, wrap } = _;
  const intl = useIntl();
  const { status, project } = useProjectContext();
  const account_id = useTypedRedux("account", "account_id");
  const host_info = useTypedRedux("projects", "host_info");
  const active_top_tab = useTypedRedux("page", "active_top_tab");
  const projectIsVisible = active_top_tab === project_id;
  const [datastoreReload, setDatastoreReload] = useState<number>(0);
  const [expandedPanels, setExpandedPanels] = useState<string[]>([]);
  const hostId = project?.get("host_id") as string | undefined;
  const hostInfo = hostId ? host_info?.get(hostId) : undefined;
  const effectiveState =
    normalizeProjectStateForDisplay({
      projectState: status?.get("state"),
      hostId,
      hostInfo,
    }) ?? status?.get("state");
  const { sections } = useProjectSettingsSections({
    project_id,
    account_id,
    project,
    mode: "flyout",
    datastoreReload,
    recoveryExtra: renderDatastoreReload(),
  });

  useEffect(() => {
    const state = getFlyoutSettings(project_id);
    setExpandedPanels(state);
  }, []);

  function renderI18N(msg: string | IntlMessage): string {
    if (isIntlMessage(msg)) {
      return intl.formatMessage(msg);
    } else {
      return msg;
    }
  }

  function renderState() {
    if (status == null) return <Loading />;
    const s = effectiveState;
    const iconName = COMPUTE_STATES[s]?.icon;
    const str = COMPUTE_STATES[s]?.display ?? s;

    const display = (
      <>
        <Icon name={iconName as IconName} /> {renderI18N(str)}
      </>
    );

    switch (
      s as any // TODO: is "pending" a "ProjectStatus"?
    ) {
      case "running":
        return <span style={{ color: "green" }}>{display}</span>;
      case "starting":
        return <span style={{ color: "orange" }}>{display}</span>;
      case "pending":
        return <span style={{ color: "orange" }}>{display}</span>;
      case "stopping":
        return <span style={{ color: "orange" }}>{display}</span>;
      case "closed":
      case "archived":
      case "opened":
        return <span style={{ color: "red" }}>{display}</span>;
      default:
        console.warn(`Unknown project state: ${s}`);
        return <span style={{ color: "red" }}>Unknown</span>;
    }
  }

  function renderStatus(): React.JSX.Element | undefined {
    // this prevents the start/stop popup dialog to stick around, if we switch somewhere else
    if (!projectIsVisible) return;
    return (
      <div
        style={{
          padding: FLYOUT_PADDING,
          marginBottom: "20px",
        }}
      >
        <Title level={4}>
          Status: <span style={{ float: "right" }}>{renderState()}</span>
        </Title>
        <Space.Compact>
          <RestartProject project_id={project_id} />
          <StopProject
            project_id={project_id}
            disabled={effectiveState !== "running"}
          />
          <MoveProject project_id={project_id} />
        </Space.Compact>
        <ProjectControlError style={{ marginTop: "15px" }} />
      </div>
    );
  }

  function setExpandedPanelsHandler(keys: string[]) {
    setExpandedPanels(keys);
    storeFlyoutState(project_id, "settings", {
      settings: keys,
    });
  }

  function renderDatastoreReload() {
    return (
      <Tooltip title={`Reload ${DATASTORE_TITLE} information`}>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={(e) => {
            e.stopPropagation();
            setDatastoreReload((prev) => prev + 1);
          }}
        />
      </Tooltip>
    );
  }

  function renderSettings() {
    if (project == null) return <Loading theme="medium" transparent />;

    const items: CollapseProps["items"] = sections.map((section) => ({
      key: section.id,
      label: (
        <>
          <Icon name={section.icon} /> {section.title}
        </>
      ),
      className: section.className,
      extra: section.extra,
      children: section.children,
    }));

    return (
      <Collapse
        style={{ borderRadius: 0, borderLeft: "none", borderRight: "none" }}
        activeKey={expandedPanels}
        onChange={(keys) => setExpandedPanelsHandler(keys as string[])}
        destroyOnHidden={true}
        items={items}
      />
    );
  }

  return wrap(
    <Space orientation="vertical" style={{ padding: "0", width: "100%" }}>
      {renderStatus()}
      {renderSettings()}
    </Space>,
  );
}
