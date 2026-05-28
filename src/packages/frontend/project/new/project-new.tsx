/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Col, Row } from "@cocalc/frontend/antd-bootstrap";
import { Alert } from "antd";
import { useProjectContext } from "@cocalc/frontend/project/context";
import NewFilePage from "./new-file-page";
import { ROOT_STYLE } from "../servers/consts";

interface Props {
  project_id: string;
}

export function ProjectNew({ project_id }: Props): React.JSX.Element {
  const { mainWidthPx, projectAccess } = useProjectContext();

  if (!projectAccess.capabilities.writeProjectFiles) {
    return (
      <Alert
        showIcon
        type="info"
        style={{ margin: "24px" }}
        message="Viewer access is read-only"
        description="Viewers can browse and open allowed files, but cannot create new files or folders in this project."
      />
    );
  }

  const isWide = mainWidthPx > 800;
  const offset = isWide ? 1 : 0;

  return (
    <Row style={{ ...ROOT_STYLE, maxWidth: null, margin: null }}>
      <Col md={12} mdOffset={0} lg={12 - 2 * offset} lgOffset={offset}>
        <NewFilePage project_id={project_id} />
      </Col>
    </Row>
  );
}
