import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { getWebpackPublicPath } from "./webpack-public-path";

// See https://webpack.js.org/guides/public-path/
// and it's pretty cool this is supported!!
declare var __webpack_public_path__: any;

__webpack_public_path__ = getWebpackPublicPath(appBasePath);
