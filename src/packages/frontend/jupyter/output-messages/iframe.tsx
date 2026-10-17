/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Handle iframe output messages involving a src doc.
*/

import { Spin } from "antd";
import { useState } from "react";
import useBlob from "./use-blob";
import ShowError from "@cocalc/frontend/components/error";
import HtmlOutput from "./html-output";

interface Props {
  sha1: string;
  actions?;
  cacheid?: string;
  index?: number;
  trust?: boolean;
}

// The blob is HTML; it renders like any other HTML output (trust plays no
// part).
export default function IFrame(props: Props) {
  const [error, setError] = useState<string>("");
  const html = useBlob({
    sha1: props.sha1,
    actions: props.actions,
    type: "text/html",
    setError,
    leaveAsString: () => true,
  });

  if (error) {
    return (
      <ShowError
        error={error}
        setError={setError}
        style={{ margin: "5px 0" }}
      />
    );
  }
  if (html == null) {
    return (
      <div>
        <Spin delay={1000} />
      </div>
    );
  }
  return <HtmlOutput value={html} />;
}
