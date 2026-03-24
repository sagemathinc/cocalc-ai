// Specify the favicon.

import { Helmet } from "react-helmet";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";
import useCustomize from "./customize";

export default function LoadFavicons() {
  const customize = useCustomize();

  return (
    <Helmet>
      <link
        rel="icon"
        href={
          customize.logo_square
            ? customize.logo_square
            : joinUrlPath(appBasePath, "webapp/favicon.ico")
        }
      />
    </Helmet>
  );
}
