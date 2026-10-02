// cSpell:ignore collabs

import type { TourProps } from "antd";
import { Button, Tour } from "antd";
import { useState } from "react";
import { useIntl } from "react-intl";

import { redux, useRedux } from "@cocalc/frontend/app-framework";
import { DocsLink } from "@cocalc/frontend/docs/link";
import { Icon } from "@cocalc/frontend/components/icon";
import { SiteName } from "@cocalc/frontend/customize";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import { labels } from "@cocalc/frontend/i18n";

export default function ProjectsPageTour({
  searchRef,
  filtersRef,
  projectListRef,
  createNewRef,
  filenameSearchRef,
  style,
}) {
  const tours = useRedux("account", "tours");
  const [open, setOpen] = useState<boolean>(false);
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const projectsLabel = intl.formatMessage(labels.projects);
  const projectLabelLower = projectLabel.toLowerCase();
  const projectsLabelLower = projectsLabel.toLowerCase();
  if (IS_MOBILE || tours?.includes("all") || tours?.includes("projects")) {
    return null;
  }
  const steps: TourProps["steps"] = [
    {
      title: (
        <>
          <Icon name="folder-open" /> The {projectsLabel} Page{" "}
          <DocsLink slug="projects/project-list">(docs)</DocsLink>
        </>
      ),
      description: (
        <div>
          Welcome to <SiteName />
          's {projectsLabel} Page! It gives you an overview about all your{" "}
          projects, where you have access to.
        </div>
      ),
    },
    {
      title: (
        <>
          <Icon name="plus-circle" /> Create {projectsLabel}
        </>
      ),
      description: (
        <div>
          Click the "Create {projectLabel}" button to instantiate a new project.
          You can specify the {projectLabelLower}'s title, and customize the
          image and license.
        </div>
      ),
      target: () => createNewRef.current,
    },
    {
      title: (
        <>
          <Icon name="folder-open" /> {projectLabel} List
        </>
      ),
      description: (
        <div>
          <p>
            The core of the {projectsLabelLower} page is the list of your{" "}
            {projectsLabelLower}. Each {projectLabelLower} is a separate project
            containing files, data, and settings specific to that{" "}
            {projectLabelLower}. By organizing your work into{" "}
            {projectsLabelLower}, you can easily collaborate with others, manage
            your files, and maintain different environments for various{" "}
            {projectsLabelLower}.
          </p>
          <p>
            At a glance, you can view important information about each{" "}
            {projectLabelLower} like its description, run state, the last time
            it was edited, and the collaborators involved. An avatar or a color
            makes it easier to recognize.
          </p>
          <p>
            Finally, <Icon name="pushpin" /> pin a {projectLabelLower} to keep
            it in the Pinned section at the top, and drag pins by their handle
            to put them in the order you like. Switch between cards and a list
            with the buttons above the list; select {projectsLabelLower} with
            their checkboxes (shift-click selects a range) to start, stop, hide
            or delete several at once.
          </p>
        </div>
      ),
      target: () => projectListRef.current,
    },

    {
      title: (
        <>
          <Icon name="tags-outlined" /> Filter by hashtags
        </>
      ),
      description: (
        <div>
          Put hashtags like #thesis in {projectLabelLower} titles or
          descriptions, then pick them here to show only those{" "}
          {projectsLabelLower}.
        </div>
      ),
      target: () => searchRef.current,
    },

    {
      title: `Hidden ${projectsLabelLower}`,
      description: (
        <>
          <p>
            Hidden {projectsLabelLower} in CoCalc help keep your{" "}
            {projectLabelLower} list organized by selectively displaying the
            work that is currently relevant. Hiding a {projectLabelLower} only
            affects your own list and can be undone here.
          </p>
        </>
      ),
      target: () => filtersRef.current,
    },
    {
      title: (
        <>
          <Icon name="search" /> Search
        </>
      ),
      target: () => filenameSearchRef.current,
      description: (
        <div>
          Type to narrow the list (the same box as in the sidebar). Press Enter
          to search everything: {projectsLabelLower} by name, file names and
          file contents in your {projectsLabelLower}, agents, artifacts and
          conversations.
        </div>
      ),
    },
    {
      title: "Thanks!",
      description: (
        <>
          The <SiteName /> {projectsLabelLower} page offers an easy-to-use
          interface that simplifies {projectLabelLower} management,
          collaboration, and organization.
          <br />
          <br />
          <Button
            type="primary"
            icon={<Icon name="check" />}
            onClick={() => {
              const actions = redux.getActions("account");
              actions.setTourDone("projects");
            }}
          >
            Hide tour
          </Button>
        </>
      ),
    },
  ];
  return (
    <>
      <Button
        type="dashed"
        style={style}
        onClick={() => {
          setOpen(true);
        }}
      >
        <Icon name="map" /> Tour
      </Button>
      <Tour
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        steps={steps}
      />
    </>
  );
}
