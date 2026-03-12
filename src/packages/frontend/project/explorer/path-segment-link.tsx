/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Tooltip } from "antd";

import { CSS } from "@cocalc/frontend/app-framework";

interface Props {
  path: string;
  display?: string | React.JSX.Element;
  on_click: (path: string) => void;
  full_name?: string;
  history?: boolean;
  active?: boolean;
  key: number;
  style?: CSS;
  dropPath?: string;
}

export interface PathSegmentItem {
  key: number;
  title: React.JSX.Element | string | undefined;
  onClick: () => void;
  className: string;
  style?: CSS;
}

// One segment of the directory links at the top of the files listing.
export function createPathSegmentLink({
  path = "/",
  display,
  on_click,
  full_name,
  history,
  active = false,
  key,
  style,
  dropPath,
}: Readonly<Props>): PathSegmentItem {
  function render_content(): React.JSX.Element | string | undefined {
    const content =
      full_name && full_name !== display ? (
        <Tooltip title={full_name} placement="bottom">
          {display}
        </Tooltip>
      ) : (
        display
      );

    if (dropPath == null) {
      return content;
    }

    return (
      <span
        data-folder-drop-path={dropPath}
        style={{ display: "inline-flex", alignItems: "center" }}
      >
        {content}
      </span>
    );
  }

  function cls() {
    if (history) {
      return "cc-path-navigator-history";
    } else if (active) {
      return "cc-path-navigator-active";
    } else {
      return "cc-path-navigator-basic";
    }
  }

  return {
    onClick: () => on_click(path),
    className: cls(),
    key,
    title: render_content(),
    style,
  };
}
