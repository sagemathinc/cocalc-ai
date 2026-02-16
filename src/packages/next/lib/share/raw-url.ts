/*
The raw URL is the following, of course encoded as a URL:

.../raw/{share id}/{the full path in the project to file}
*/

import { join } from "path";
import ROOT_PATH from "lib/root-path";

interface Options {
  id: string;
  path: string;
  relativePath: string;
}

export default function rawURL({ id, path, relativePath }: Options): string {
  return join(
    ROOT_PATH,
    `share/raw/${id}/${encodePath(join(path, relativePath))}`
  );
}

export function encodePath(path: string) {
  const segments = path.split("/");
  const encoded: string[] = [];
  for (const segment of segments) {
    encoded.push(encodeURIComponent(segment));
  }
  return encoded.join("/");
}
