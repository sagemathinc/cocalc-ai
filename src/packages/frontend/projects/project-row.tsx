/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Render a single project entry, which goes in the list of projects
*/

import { Col, Row, Well } from "@cocalc/frontend/antd-bootstrap";
import {
  CSS,
  React,
  useActions,
  useRedux,
  useState,
} from "@cocalc/frontend/app-framework";
import { AddCollaborators } from "@cocalc/frontend/collaborators";
import {
  Gap,
  Icon,
  Markdown,
  ProjectState,
  TimeAgo,
} from "@cocalc/frontend/components";
import track from "@cocalc/frontend/user-tracking";
import { COLORS } from "@cocalc/util/theme";
import { Button, Tooltip } from "antd";
import { ProjectAvatarImage } from "./project-avatar";
import { ProjectUsers } from "./project-users";
import { useBookmarkedProjects } from "./use-bookmarked-projects";
import { blendBackgroundColor } from "./util";

interface Props {
  project_id: string;
  index?: number;
}

export const ProjectRow: React.FC<Props> = ({ project_id, index }: Props) => {
  const [selection_at_last_mouse_down, set_selection_at_last_mouse_down] =
    useState<string>("");
  const project = useRedux(["projects", "project_map", project_id]);

  const [add_collab, set_add_collab] = useState<boolean>(false);

  const actions = useActions("projects");
  const { isProjectBookmarked, setProjectBookmarked } = useBookmarkedProjects();

  function render_star(): React.JSX.Element {
    const isStarred = isProjectBookmarked(project_id);
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          minHeight: "21px",
          cursor: "pointer",
        }}
        onClick={(e) => {
          e.stopPropagation();
          setProjectBookmarked(project_id, !isStarred);
        }}
      >
        <Icon
          name={isStarred ? "star-filled" : "star"}
          style={{
            color: isStarred ? COLORS.STAR : COLORS.GRAY,
            fontSize: "16px",
          }}
        />
      </div>
    );
  }

  function render_add_collab(): React.JSX.Element | undefined {
    if (!add_collab) {
      return;
    }
    return (
      <AddCollaborators
        project_id={project_id}
        autoFocus
        where="projects-list"
      />
    );
  }

  function render_collab(): React.JSX.Element {
    return (
      <div>
        <div
          style={{ maxHeight: "7em", overflowY: "auto" }}
          onClick={(e) => {
            set_add_collab(!add_collab);
            e.stopPropagation();
          }}
        >
          <a>
            {" "}
            <span style={{ fontSize: "15pt" }}>
              <Icon name={add_collab ? "caret-down" : "caret-right"} />
            </span>
            <Gap />
            <Icon
              name="user"
              style={{ fontSize: "16pt", marginRight: "10px" }}
            />
            <ProjectUsers project={project} />
          </a>
        </div>
        {render_add_collab()}
      </div>
    );
  }

  function render_project_description() {
    const desc = project.get("description");
    if (desc == "No Description") {
      // Don't bother showing the "No Description" default; it's clutter
      return;
    }
    return <Markdown style={{ color: COLORS.GRAY }} value={desc} />;
  }

  function handle_mouse_down(): void {
    set_selection_at_last_mouse_down((window.getSelection() ?? "").toString());
  }

  function handle_click(e?, force?: boolean): void {
    if (!force && add_collab) return;
    const cur_sel = (window.getSelection() ?? "").toString();
    // Check if user has highlighted some text.  Do NOT open if the user seems
    // to be trying to highlight text on the row, e.g., for copy pasting.
    if (cur_sel === selection_at_last_mouse_down) {
      open_project_from_list(e);
    }
  }

  function open_project_from_list(e?): void {
    actions.open_project({
      project_id,
      target: "project-home",
      switch_to: !(e?.which === 2 || e?.ctrlKey || e?.metaKey),
    });
    e?.preventDefault();
    track("open_project", { how: "projects_page", project_id });
  }

  function open_project_settings(e): void {
    if (add_collab) return;
    actions.open_project({
      project_id,
      switch_to: !(e.which === 2 || e.ctrlKey || e.metaKey),
      target: "settings",
    });
    e.stopPropagation();
  }

  const color = project.get("color");
  const borderStyle = color ? `4px solid ${color}` : undefined;

  // Calculate background color with faint hint of project color
  const isEvenRow = (index ?? 0) % 2 === 1;
  const baseColor = isEvenRow ? COLORS.GRAY_LL : "white"; // even color same as background in projects-nav.ts ProjectsNav::renderTabBar0
  const backgroundColor = blendBackgroundColor(color, baseColor, isEvenRow);

  const project_row_styles: CSS = {
    backgroundColor,
    marginBottom: 0,
    cursor: "pointer",
    wordWrap: "break-word",
    ...(borderStyle
      ? {
          borderLeft: borderStyle,
          borderRight: borderStyle,
        }
      : undefined),
  };

  if (project == null) {
    return <></>;
  }

  return (
    <Well style={project_row_styles} onMouseDown={handle_mouse_down}>
      <Row>
        <Col
          sm={1}
          style={{
            maxWidth: "50px",
            padding: "0 5px",
            alignSelf: "flex-start",
          }}
        >
          {render_star()}
        </Col>
        <Col
          onClick={handle_click}
          sm={3}
          style={{
            maxHeight: "10em",
            overflowY: "auto",
          }}
        >
          <div style={{ fontWeight: "bold", display: "flex" }}>
            <a
              cocalc-test="project-line"
              onClick={() => handle_click(undefined, true)}
            >
              <Markdown value={project.get("title")} />
            </a>
          </div>
          <TimeAgo date={project.get("last_edited")} />
        </Col>
        <Col
          onClick={handle_click}
          sm={2}
          style={{
            color: COLORS.GRAY,
            maxHeight: "10em",
            overflowY: "auto",
          }}
        >
          {render_project_description()}
        </Col>
        <Col sm={3}>{render_collab()}</Col>
        <Col sm={1} onClick={open_project_settings}>
          <a>
            <ProjectState state={project.get("state")} />
          </a>
        </Col>
        <Col sm={2}>
          {project.get("avatar_image_tiny") && (
            <ProjectAvatarImage
              project_id={project_id}
              size={120}
              onClick={handle_click}
              style={{ margin: "-20px 0", textAlign: "center" }}
            />
          )}
        </Col>
        <Col sm={1}>
          <Tooltip
            title={`Cloning ${project.get("title")} makes an exact complete copy of the project, including any customization to the root filesystem / (e.g., systemwide software install).  It has the same root filesystem image.`}
          >
            <Button>
              <Icon name="fork-outlined" /> Clone
            </Button>
          </Tooltip>
        </Col>
      </Row>
    </Well>
  );
};
