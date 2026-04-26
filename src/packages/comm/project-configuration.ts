/*
Shared types and constants between frontend app and project for computing project
configuration information.
*/

import type { ConfigurationAspect } from "@cocalc/comm/websocket/types";
import {
  DEFAULT_PROJECT_RUNTIME_GID,
  DEFAULT_PROJECT_RUNTIME_HOME,
  DEFAULT_PROJECT_RUNTIME_UID,
  DEFAULT_PROJECT_RUNTIME_USER,
} from "@cocalc/util/project-runtime";

export type { ConfigurationAspect };

export interface MainConfiguration {
  capabilities: MainCapabilities;
  timestamp: Date;
  // disabled extensions, for opening/creating files
  disabled_ext: string[];
}

export type Capabilities = { [key: string]: boolean };

export interface X11Configuration {
  timestamp: Date;
  capabilities: Capabilities;
}

export type Configuration = MainConfiguration | X11Configuration;

export interface MainCapabilities {
  jupyter: boolean | Capabilities;
  formatting: Capabilities; // yapf & co.
  hashsums: Capabilities;
  rserver: boolean;
  latex: boolean;
  sage: boolean;
  sage_version?: number[];
  x11: boolean;
  rmd: boolean;
  qmd: boolean;
  jq: boolean;
  spellcheck: boolean;
  sshd: boolean;
  nodejs: boolean;
  gitlfs: boolean;
  imagemagick: boolean;
  ffmpeg: boolean;
  typst: boolean;
  python: boolean;
  pip: boolean;
  conda: boolean;
  uv: boolean;
  html2pdf: boolean; // via chrome/chromium
  pandoc: boolean; // e.g. for docx2md conversion
  vscode: boolean; // "code-server"
  julia: boolean; // julia programming language + Pluto package is installed (we assume it)
  homeDirectory: string | null; // the home directory of the project
  runtimeUser?: string | null;
  runtimeUid?: number | null;
  runtimeGid?: number | null;
  sudoAvailable?: boolean;
}

export interface Available {
  jupyter_lab: boolean;
  jupyter_notebook: boolean;
  jupyter: boolean;
  rserver: boolean;
  x11: boolean;
  latex: boolean;
  sage: boolean;
  rmd: boolean; // TODO besides R, what's necessary? pandoc!
  qmd: boolean; // also depends on pandoc
  jq: boolean;
  spellcheck: boolean;
  sshd: boolean;
  nodejs: boolean;
  gitlfs: boolean;
  imagemagick: boolean;
  ffmpeg: boolean;
  typst: boolean;
  python: boolean;
  pip: boolean;
  conda: boolean;
  uv: boolean;
  html2pdf: boolean;
  pandoc: boolean;
  vscode: boolean;
  julia: boolean;
  formatting: Capabilities | boolean;
  homeDirectory: string | null;
  runtimeUser?: string | null;
  runtimeUid?: number | null;
  runtimeGid?: number | null;
  sudoAvailable?: boolean;
}

export const NO_AVAIL: Readonly<Available> = {
  jupyter_lab: false,
  jupyter_notebook: false,
  jupyter: false,
  rserver: false,
  sage: false,
  latex: false,
  rmd: false,
  qmd: false,
  jq: false,
  x11: false,
  spellcheck: false,
  sshd: false,
  nodejs: false,
  gitlfs: false,
  imagemagick: false,
  ffmpeg: false,
  typst: false,
  python: false,
  pip: false,
  conda: false,
  uv: false,
  formatting: false,
  html2pdf: false,
  pandoc: false,
  vscode: false,
  julia: false,
  homeDirectory: null,
  runtimeUser: null,
  runtimeUid: null,
  runtimeGid: null,
  sudoAvailable: false,
} as const;

export const ALL_AVAIL: Readonly<Available> = {
  jupyter_lab: true,
  jupyter_notebook: true,
  jupyter: true,
  rserver: true,
  sage: true,
  latex: true,
  rmd: true,
  qmd: true,
  jq: true,
  x11: true,
  spellcheck: true,
  sshd: true,
  nodejs: true,
  gitlfs: true,
  imagemagick: true,
  ffmpeg: true,
  typst: true,
  python: true,
  pip: true,
  conda: true,
  uv: true,
  formatting: true,
  html2pdf: true,
  pandoc: true,
  vscode: true,
  julia: true,
  homeDirectory: DEFAULT_PROJECT_RUNTIME_HOME,
  runtimeUser: DEFAULT_PROJECT_RUNTIME_USER,
  runtimeUid: DEFAULT_PROJECT_RUNTIME_UID,
  runtimeGid: DEFAULT_PROJECT_RUNTIME_GID,
  sudoAvailable: true,
} as const;
