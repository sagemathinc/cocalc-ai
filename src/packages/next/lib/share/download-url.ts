// See comment in raw-url for the definition.  This is the same, but with "raw" replaced by "download".

import { encodePath } from "./raw-url";
import { join } from "path";
import ROOT_PATH from "lib/root-path";

export default function downloadURL(
  id: string,
  path: string,
  relativePath: string
): string {
  return join(
    ROOT_PATH,
    `share/download/${id}/${encodePath(join(path, relativePath))}`
  );
}
