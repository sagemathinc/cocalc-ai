/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useIntl } from "react-intl";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import { isIntlMessage } from "@cocalc/frontend/i18n";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { PathNavigator } from "@cocalc/frontend/project/explorer/path-navigator";

import { capitalize } from "@cocalc/util/misc";
import { FIX_BORDER } from "../common";
import { FIXED_PROJECT_TABS, FixedTab } from "../file-tab";
import { FIXED_TABS_BG_COLOR } from "../activity-bar-tabs";
import { ActiveHeader } from "./active-header";
import { FLYOUT_PADDING } from "./consts";
import { LogHeader } from "./log-header";
import { useFlyoutNavigation } from "./use-flyout-navigation";

interface Props {
  flyoutWidth: number;
  flyout: FixedTab;
  narrowerPX: number;
}

export function FlyoutHeader(_: Readonly<Props>) {
  const { flyout, flyoutWidth, narrowerPX = 0 } = _;
  const intl = useIntl();
  const { actions, project_id } = useProjectContext();
  const flyoutNavigation = useFlyoutNavigation(project_id);
  const compactHeader = flyout === "log";

  function renderDefaultTitle() {
    const title =
      FIXED_PROJECT_TABS[flyout].flyoutTitle ??
      FIXED_PROJECT_TABS[flyout].label;
    if (title != null) {
      return isIntlMessage(title) ? intl.formatMessage(title) : title;
    } else {
      return capitalize(flyout);
    }
  }

  function renderIcon() {
    const iconName = FIXED_PROJECT_TABS[flyout].icon;
    if (iconName != null) {
      return <Icon name={iconName} />;
    } else {
      return null;
    }
  }

  function closeBtn() {
    return (
      <Tooltip
        title={intl.formatMessage({
          id: "flyouts.header.hide.tooltip",
          defaultMessage: "Hide this panel",
        })}
        placement="bottom"
      >
        <Icon
          name="times"
          className="cc-project-fixedtab-close"
          style={{
            marginRight: FLYOUT_PADDING,
            padding: FLYOUT_PADDING,
            flexShrink: 0,
          }}
          onClick={() => actions?.toggleFlyout(flyout)}
        />
      </Tooltip>
    );
  }

  function fullPageBtn() {
    // active files has no fullpage equivalent – it's the tabs
    if (flyout === "active") return null;

    const style = {
      marginRight: FLYOUT_PADDING,
      padding: FLYOUT_PADDING,
      fontSize: "12px",
      flexShrink: 0,
    };

    return (
      <>
        <Tooltip
          title="Open as full page"
          placement="bottom"
          mouseEnterDelay={0.2}
        >
          <Icon
            name="expand"
            className="cc-project-fixedtab-fullpage"
            style={style}
            onClick={() => {
              // flyouts and full pages share the same internal name
              actions?.set_active_tab(flyout);

              // now, close the flyout panel, to finish the transition
              actions?.toggleFlyout(flyout);
            }}
          />
        </Tooltip>
      </>
    );
  }

  function renderTitle() {
    switch (flyout) {
      case "files":
        return (
          <div style={{ flex: "1 1 0", minWidth: 0, overflow: "hidden" }}>
            <PathNavigator
              style={{ flex: 1, minWidth: 0, maxWidth: "100%" }}
              mode={"flyout"}
              project_id={project_id}
              showSourceSelector
              className={"cc-project-flyout-path-navigator"}
              currentPath={flyoutNavigation.flyoutPath}
              historyPath={flyoutNavigation.flyoutHistory}
              onNavigate={flyoutNavigation.navigateFlyout}
              canGoBack={flyoutNavigation.canGoBack}
              canGoForward={flyoutNavigation.canGoForward}
              onGoBack={flyoutNavigation.goBack}
              onGoForward={flyoutNavigation.goForward}
              backHistory={flyoutNavigation.backHistory}
              forwardHistory={flyoutNavigation.forwardHistory}
            />
          </div>
        );
      case "log":
        return <LogHeader />;
      case "search":
        return <SearchHeader />;
      case "active":
        return <ActiveHeader />;
      default:
        return (
          <div
            style={{
              flex: "1 1 0",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontWeight: "bold",
            }}
          >
            {renderIcon()} {renderDefaultTitle()}
          </div>
        );
    }
  }

  return (
    <div
      style={{
        boxSizing: "border-box",
        height: compactHeader ? "36px" : "40px",
        overflow: "hidden",
        display: "flex",
        flexDirection: "row",
        alignItems: compactHeader ? "center" : "flex-start",
        gap: FLYOUT_PADDING,
        borderRight: FIX_BORDER,
        borderTop: FIX_BORDER,
        borderLeft: FIX_BORDER,
        background: FIXED_TABS_BG_COLOR,
        borderRadius: "5px 5px 0 0",
        width: `${flyoutWidth - narrowerPX}px`,
        paddingLeft: FLYOUT_PADDING,
        paddingTop: compactHeader ? 0 : "10px",
        fontSize: "1.2em",
        marginRight: FLYOUT_PADDING,
      }}
    >
      {renderTitle()}
      <div
        style={{
          display: "flex",
          flex: "0 0 auto",
          alignItems: "center",
          gap: FLYOUT_PADDING,
        }}
      >
        {fullPageBtn()}
        {closeBtn()}
      </div>
    </div>
  );
}

function SearchHeader() {
  const { project_id } = useProjectContext();
  return (
    <div
      style={{
        flex: "1 1 0",
        minWidth: 0,
        display: "flex",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        fontWeight: "bold",
      }}
    >
      <Icon name="search" style={{ fontSize: "120%", marginRight: "10px" }} />{" "}
      <PathNavigator
        style={{ flex: "1 1 0", minWidth: 0, maxWidth: "100%" }}
        mode={"flyout"}
        project_id={project_id}
        className={"cc-project-flyout-path-navigator"}
      />
    </div>
  );
}
