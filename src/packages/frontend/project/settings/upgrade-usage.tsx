/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { FormattedMessage } from "react-intl";

import { React, Rendered } from "@cocalc/frontend/app-framework";
import { Loading, Title } from "@cocalc/frontend/components";
import { GPU } from "@cocalc/util/types/gpu";
import { RunQuota } from "./run-quota";
import { Project } from "./types";

interface Props {
  project_id: string;
  project: Project;
  gpu?: GPU | false;
  mode: "project" | "flyout";
}

export const UpgradeUsage: React.FC<Props> = React.memo(
  ({ project_id, project, mode }: Readonly<Props>) => {
    function render_run_quota(): Rendered {
      return (
        <RunQuota
          project_id={project_id}
          project_state={project.getIn(["state", "state"])}
          project={project}
          mode={mode}
        />
      );
    }

    // This is is just a precaution, since "project" isn't properly typed
    if (project == null) {
      return <Loading theme="medium" transparent />;
    }

    return (
      <div>
        <Title level={4}>
          <FormattedMessage
            id="project.settings.upgrade-usage.header"
            defaultMessage={"Memory"}
          />
        </Title>
        {render_run_quota()}
      </div>
    );
  },
);
