// Specify the favicon.

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";
import useCustomize from "./customize";
import HeadTags from "./head";

export default function LoadFavicons() {
  const customize = useCustomize();

  return (
    <HeadTags
      tags={[
        {
          tag: "link",
          attrs: {
            rel: "icon",
            href: customize.logo_square
              ? customize.logo_square
              : joinUrlPath(appBasePath, "webapp/favicon.ico"),
          },
        },
      ]}
    />
  );
}
