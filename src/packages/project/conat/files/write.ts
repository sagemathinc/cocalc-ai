/*

DEVELOPMENT:


1. Setup the project environment variables. Then start the server in node:


    ~/cocalc/src/packages/project/conat$ . project-env.sh
    $ node
    Welcome to Node.js v18.17.1.
    Type ".help" for more information.

    require('@cocalc/project/conat/files/write').init()


*/

import "@cocalc/project/conat/env"; // ensure conat env available
import ensureContainingDirectoryExists from "@cocalc/backend/misc/ensure-containing-directory-exists";
import { createWriteStream as fs_createWriteStream } from "fs";
import { rename } from "fs/promises";
import {
  createServer,
  close as closeWriteServer,
} from "@cocalc/conat/files/write";
import type { FileWriteStream } from "@cocalc/conat/files/write-stream";
import { finished } from "node:stream/promises";
import { randomId } from "@cocalc/conat/names";
import { rimraf } from "rimraf";
import { getIdentity } from "../connection";
import { projectFilePath } from "./path";

async function createWriteStream(path: string) {
  // console.log("createWriteStream", { path });
  path = projectFilePath(path);
  await ensureContainingDirectoryExists(path);
  const partial = path + `.partialupload-${randomId()}`;
  const stream: FileWriteStream = fs_createWriteStream(partial);
  stream.remove = async () => {
    await finished(stream, { cleanup: true }).catch(() => undefined);
    await rimraf(partial);
  };
  stream.commit = async () => {
    await rename(partial, path);
  };
  return stream;
}

// the project should call this on startup:
export async function init(opts?) {
  await createServer({ ...getIdentity(opts), createWriteStream });
}

export async function close(opts?) {
  await closeWriteServer(getIdentity(opts));
}
