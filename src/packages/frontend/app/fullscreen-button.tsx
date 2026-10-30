/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button } from "antd";
import { useEffect, useRef } from "react";
import { useIntl } from "react-intl";

import {
  CSS,
  React,
  useActions,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { Icon, Tip } from "@cocalc/frontend/components";

import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  FULLSCREEN_CONTROL,
  handOffFullscreenFocus,
  takeFullscreenFocus,
} from "./fullscreen-focus";
import {
  NAV_HEIGHT_PX,
  PageStyle,
  TOP_BAR_ELEMENT_CLASS,
} from "./top-nav-consts";

// In fullscreen the exit control is anchored in the page flow right after the
// banners (impersonation, session, ...), at the top right of the content. A
// zero-height anchor takes no space, and the control can never sit under a
// banner, as the old fixed top-right icon did.
const EXIT_ANCHOR_STYLE: CSS = {
  position: "relative",
  height: 0,
  zIndex: 1000,
} as const;

const EXIT_BUTTON_STYLE: CSS = {
  position: "absolute",
  right: "8px",
  top: "6px",
  boxShadow: `0 1px 4px ${UI_COLORS.shadow}`,
} as const;

interface Props {
  pageStyle: PageStyle;
  // Only the enter control: the page renders the one exit control after the
  // banners, so other placements (the agents sidebar) must not add another.
  enterOnly?: boolean;
}

export const FullscreenButton: React.FC<Props> = React.memo((props: Props) => {
  const { pageStyle, enterOnly } = props;
  const { fontSizeIcons } = pageStyle;

  const intl = useIntl();
  const fullscreen = useTypedRedux("page", "fullscreen");
  const page_actions = useActions("page");
  // the enter or the exit button, whichever is rendered
  const controlRef = useRef<HTMLButtonElement>(null);

  // Take the focus handed off by the control that a transition unmounted.
  useEffect(() => {
    takeFullscreenFocus(controlRef.current);
  }, [fullscreen]);

  function toggle(): void {
    handOffFullscreenFocus();
    page_actions.toggle_fullscreen();
  }

  if (fullscreen == "kiosk" || fullscreen == "project") {
    // no button, since can't get out.
    return <></>;
  }

  if (fullscreen === "default") {
    if (enterOnly) return null;
    const label = intl.formatMessage({
      id: "app.fullscreen-button.exit",
      defaultMessage: "Exit fullscreen",
    });
    return (
      <div style={EXIT_ANCHOR_STYLE}>
        <Button
          ref={controlRef}
          {...{ [FULLSCREEN_CONTROL]: "" }}
          size="small"
          style={EXIT_BUTTON_STYLE}
          icon={<Icon name="compress" />}
          onClick={toggle}
        >
          {label}
        </Button>
      </div>
    );
  }

  // Not in fullscreen: the nav button that enters it.
  const button_style: CSS = {
    fontSize: fontSizeIcons,
    color: UI_COLORS.text,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: `${NAV_HEIGHT_PX}px`,
    width: `${NAV_HEIGHT_PX}px`,
  };

  const tooltip = intl.formatMessage({
    id: "app.fullscreen-button.tooltip",
    defaultMessage: "Fullscreen mode, focused on the current document or page.",
  });
  const label = intl.formatMessage({
    id: "app.fullscreen-button.enter",
    defaultMessage: "Enter fullscreen",
  });

  return (
    <Tip title={tooltip} placement={"bottomRight"} delayShow={2000}>
      <Button
        ref={controlRef}
        {...{ [FULLSCREEN_CONTROL]: "" }}
        type="text"
        className={TOP_BAR_ELEMENT_CLASS}
        style={button_style}
        icon={<Icon name="expand" />}
        aria-label={label}
        onClick={toggle}
      />
    </Tip>
  );
});
