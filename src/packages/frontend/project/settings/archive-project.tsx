/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button } from "antd";
import type { ButtonProps } from "antd";
import { useState } from "react";
import { FormattedMessage } from "react-intl";

import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { ArchiveProjectModal } from "@cocalc/frontend/projects/archive-project-modal";

interface Props {
  project_id: string;
  disabled?: boolean;
  size?: ButtonProps["size"];
}

export function ArchiveProject({ project_id, disabled, size }: Props) {
  const [open, setOpen] = useState(false);
  const actions = useActions("projects");
  const project_map = useTypedRedux("projects", "project_map");
  const project = project_map?.get(project_id);

  return (
    <>
      <Button
        disabled={disabled || actions == null}
        size={size}
        onClick={() => setOpen(true)}
      >
        <Icon name="file-archive" />{" "}
        <FormattedMessage
          id="project.settings.archive-project.label"
          defaultMessage="Archive"
        />
      </Button>
      <ArchiveProjectModal
        open={open}
        projects={[
          {
            project_id,
            title: project?.get("title"),
            state: `${project?.getIn(["state", "state"]) ?? ""}`,
          },
        ]}
        onCancel={() => setOpen(false)}
        onArchive={async ([id]) => {
          await actions?.archive_project(id);
        }}
      />
    </>
  );
}
