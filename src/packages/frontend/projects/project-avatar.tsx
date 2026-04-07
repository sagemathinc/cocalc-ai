/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Render a single project entry, which goes in the list of projects
*/

import { CSSProperties } from "react";

import { React, useRedux } from "@cocalc/frontend/app-framework";
import { Paragraph } from "@cocalc/frontend/components";
import { ProjectThemeAvatar } from "./theme";

interface ProjectAvatarImageProps {
  project_id: string;
  size?: number;
  onClick?: Function;
  style?: CSSProperties;
  askToAddAvatar?: boolean;
}

export function ProjectAvatarImage(props: ProjectAvatarImageProps) {
  const { project_id, size, onClick, style, askToAddAvatar = false } = props;
  const project = useRedux(["projects", "project_map", project_id]);

  function renderAdd(): React.JSX.Element {
    if (!askToAddAvatar || onClick == null) return <></>;
    return (
      <Paragraph type="secondary" style={style} onClick={(e) => onClick(e)}>
        (Click to customize appearance)
      </Paragraph>
    );
  }

  return project != null ? (
    <div style={style} onClick={(e) => onClick?.(e)}>
      <ProjectThemeAvatar project={project} shape="square" size={size ?? 160} />
    </div>
  ) : (
    renderAdd()
  );
}
