/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { ProjectCollaboratorsContent } from "../project-collaborators";

interface CollabsProps {
  project_id: string;
  wrap: (content: React.JSX.Element) => React.JSX.Element;
}

export function CollabsFlyout({
  project_id,
  wrap,
}: CollabsProps): React.JSX.Element {
  return (
    <ProjectCollaboratorsContent
      project_id={project_id}
      layout="flyout"
      wrap={wrap}
    />
  );
}
