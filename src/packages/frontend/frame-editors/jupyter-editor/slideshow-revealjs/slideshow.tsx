/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Frame for showing the notebook as a slideshow for presentations.

TODO:
 - [ ] Clicking on the slideshow iframe should focus that frame... if possible.
 - [ ] save the exact page being viewed; can be done via [iframe ref].contentDocument.URL
       and looking at the number after the slash.
 - [ ] presentation mode that makes it genuine fullscreen -- builtin "F" command *just works*,
       so even a button to cause the same would be more than enough.
 - [ ] some key shortcuts (? for help, f for fullscreen)
 - [ ] ability to customize the compilation command.
 - [ ] progress bar based on last build time.
 - [ ] support something like RISE, i.e., live functionality (?) -- https://github.com/damianavila/RISE
*/

import { delay } from "awaiting";

import {
  Rendered,
  Component,
  rclass,
  rtypes,
} from "@cocalc/frontend/app-framework";

import { Loading } from "@cocalc/frontend/components";
import { useProjectContentUrl } from "@cocalc/frontend/project/use-project-content-url";
import { CONTENT_FRAME_SANDBOX } from "@cocalc/util/project-content-origin";

import { Map } from "immutable";

import { JupyterEditorActions } from "../actions";

// The slides are HTML that nbconvert made from the notebook, including its
// outputs (which may come from anyone who could edit it), so on sites with a
// content origin they are shown there, sandboxed, like the HTML editor does.
export function SlideshowFrame({
  project_id,
  path,
  url,
}: {
  project_id: string;
  path: string;
  url: string;
}) {
  const content = useProjectContentUrl({ project_id, path, enabled: !!path });
  if (content.status == "ready") {
    return (
      <iframe
        title="Jupyter slideshow preview"
        width="100%"
        height="100%"
        style={{ border: 0 }}
        src={content.url}
        sandbox={CONTENT_FRAME_SANDBOX}
      />
    );
  }
  if (content.status == "unavailable") {
    // No content origin on this site: as before.
    return (
      <iframe
        title="Jupyter slideshow preview"
        width="100%"
        height="100%"
        src={url}
      />
    );
  }
  if (content.status == "no-access") {
    return (
      <div style={{ margin: "15px", color: "#666" }}>
        The slideshow can only be shown to collaborators of this project.
      </div>
    );
  }
  return (
    <div style={{ textAlign: "center" }}>
      <Loading theme="medium" />
    </div>
  );
}

interface Props {
  actions: JupyterEditorActions;
  // reduxProps:
  slideshow?: Map<string, string>;
}

class Slideshow extends Component<Props, {}> {
  static reduxProps({ name }) {
    return {
      [name]: {
        slideshow: rtypes.immutable.Map,
      },
    };
  }

  private render_iframe(): Rendered {
    if (this.props.slideshow == null) return;
    return (
      <SlideshowFrame
        project_id={this.props.actions.project_id}
        path={this.props.slideshow.get("path") ?? ""}
        url={this.props.slideshow.get("url") ?? ""}
      />
    );
  }

  private render_loading(): Rendered {
    return (
      <div style={{ textAlign: "center" }}>
        <Loading theme="medium" />
      </div>
    );
  }

  private render_building(): Rendered {
    return (
      <div>
        <h3 style={{ textAlign: "center", color: "#666" }}>
          Creating slideshow using nbconvert...
        </h3>
      </div>
    );
    // TODO: this would be a good place to draw a progress bar.
  }

  private async launch_build(): Promise<void> {
    // must not happen in render loop, but fine if it happens even after
    // this component unmounts.
    await delay(0);
    if (this.props.actions != null) {
      this.props.actions.build_revealjs_slideshow();
    }
  }

  render(): Rendered {
    if (this.props.slideshow == null) {
      this.launch_build();
      return this.render_loading();
    }
    if (this.props.slideshow.get("state") == "building") {
      return this.render_building();
    }
    if (this.props.slideshow.get("state") == "built") {
      return this.render_iframe();
    }
    this.launch_build();
    return this.render_loading();
  }
}

const tmp = rclass(Slideshow);
export { tmp as Slideshow };
