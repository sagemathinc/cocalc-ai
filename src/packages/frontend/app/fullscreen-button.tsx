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

// Set when the exit button is activated: the exit button unmounts, so the
// enter button that mounts next (top nav or agents sidebar) takes the focus
// instead of leaving it on the body. Expires so that a later mount, e.g.
// after a resize, never steals focus.
let focusEnterOnMount = false;
let focusEnterTimer: ReturnType<typeof setTimeout> | undefined;

function exitAndKeepFocus(toggle: () => void): void {
  focusEnterOnMount = true;
  clearTimeout(focusEnterTimer);
  focusEnterTimer = setTimeout(() => (focusEnterOnMount = false), 1000);
  toggle();
}

interface Props {
  pageStyle: PageStyle;
}

export const FullscreenButton: React.FC<Props> = React.memo((props: Props) => {
  const { pageStyle } = props;
  const { fontSizeIcons } = pageStyle;

  const intl = useIntl();
  const fullscreen = useTypedRedux("page", "fullscreen");
  const page_actions = useActions("page");
  const enterRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (focusEnterOnMount && enterRef.current != null) {
      focusEnterOnMount = false;
      enterRef.current.focus();
    }
  }, [fullscreen]);

  if (fullscreen == "kiosk" || fullscreen == "project") {
    // no button, since can't get out.
    return <></>;
  }

  if (fullscreen === "default") {
    const label = intl.formatMessage({
      id: "app.fullscreen-button.exit",
      defaultMessage: "Exit fullscreen",
    });
    return (
      <div style={EXIT_ANCHOR_STYLE}>
        <Button
          size="small"
          style={EXIT_BUTTON_STYLE}
          icon={<Icon name="compress" />}
          onClick={() =>
            exitAndKeepFocus(() => page_actions.toggle_fullscreen())
          }
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
        ref={enterRef}
        type="text"
        className={TOP_BAR_ELEMENT_CLASS}
        style={button_style}
        icon={<Icon name="expand" />}
        aria-label={label}
        onClick={() => page_actions.toggle_fullscreen()}
      />
    </Tip>
  );
});
