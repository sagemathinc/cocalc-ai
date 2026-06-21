/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { OUCH_FORMATS } from "@cocalc/conat/files/fs";

interface Entry {
  list: { command: string; args: ReadonlyArray<string> };
  extract: { command: string; args: ReadonlyArray<string> };
}

const ouch: Entry = {
  list: { command: "ouch", args: ["list", "--accessible", "--yes"] },
  extract: {
    command: "ouch",
    args: ["decompress", "--accessible", "--yes"],
  },
};

const ouchFormats = Object.fromEntries(
  OUCH_FORMATS.map((format) => [format, ouch]),
);

const bz2: Entry = {
  list: { command: "ls", args: ["-l"] },
  extract: { command: "bunzip2", args: ["-vf"] },
};

const tbz2: Entry = {
  list: { command: "tar", args: ["-jtvf"] },
  extract: { command: "tar", args: ["-xjf"] },
};

const tgz: Entry = {
  list: { command: "tar", args: ["-tzf"] },
  extract: { command: "tar", args: ["-xvzf"] },
};

export const COMMANDS: { [type: string]: Entry } = {
  ...ouchFormats,
  "tar.bz2": tbz2,
  tbz2: tbz2,
  zip: {
    list: { command: "unzip", args: ["-l"] },
    extract: { command: "unzip", args: ["-B"] },
  },
  tar: {
    list: { command: "tar", args: ["-tf"] },
    extract: { command: "tar", args: ["-xvf"] },
  },
  tgz,
  "tar.gz": tgz,
  gz: {
    list: { command: "gzip", args: ["-l"] },
    extract: { command: "gunzip", args: ["-vf"] },
  },
  bz2,
  bzip2: bz2,
  lzip: {
    list: { command: "ls", args: ["-l"] },
    extract: { command: "lzip", args: ["-vfd"] },
  },
  xz: {
    list: { command: "xz", args: ["-l"] },
    extract: { command: "xz", args: ["-vfd"] },
  },
} as const;

// all keys of COMMANDS, that have at least one "." in their name
export const DOUBLE_EXT = Object.keys(COMMANDS).filter(
  (key) => key.indexOf(".") >= 0,
);

export const ARCHIVE_EXTENSIONS = Array.from(
  new Set([
    ...Object.keys(COMMANDS),
    ...OUCH_FORMATS.flatMap((format) => format.split(".")),
  ]),
);
