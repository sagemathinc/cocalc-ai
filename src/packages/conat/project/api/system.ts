import type {
  ExecuteCodeOutput,
  ExecuteCodeRequest,
} from "@cocalc/util/types/execute-code";
import type { DirectoryListingEntry } from "@cocalc/util/types";
import type {
  HostRootfsBuildLogResponse,
  HostRootfsBuildStatusResponse,
} from "@cocalc/conat/project-host/api";
import type {
  Configuration,
  ConfigurationAspect,
} from "@cocalc/comm/project-configuration";

export const system = {
  version: true,

  listing: true,
  moveFiles: true,
  renameFile: true,
  realpath: true,

  // these should be deprecated -- the new streaming writeFile and readFile in conat/files are  better.
  writeTextFileToProject: true,
  readTextFileFromProject: true,
  readRootfsBuildLog: true,
  readRootfsBuildEvents: true,
  listRootfsBuilds: true,

  configuration: true,

  ping: true,
  exec: true,

  signal: true,

  // named servers like jupyterlab, vscode, etc.
  startNamedServer: true,
  statusOfNamedServer: true,

  // ssh support
  sshPublicKey: true,
  updateSshKeys: true,
};

export interface System {
  version: () => Promise<number>;

  listing: (opts: {
    path: string;
    hidden?: boolean;
  }) => Promise<DirectoryListingEntry[]>;
  moveFiles: (opts: { paths: string[]; dest: string }) => Promise<void>;
  renameFile: (opts: { src: string; dest: string }) => Promise<void>;
  realpath: (path: string) => Promise<string>;

  writeTextFileToProject: (opts: {
    path: string;
    content: string;
  }) => Promise<void>;
  readTextFileFromProject: (opts: { path: string }) => Promise<string>;
  readRootfsBuildLog: (opts: {
    build_id: string;
    lines?: number;
    byte_offset?: number;
    max_bytes?: number;
  }) => Promise<HostRootfsBuildLogResponse>;
  readRootfsBuildEvents: (opts: {
    build_id: string;
    lines?: number;
    byte_offset?: number;
    max_bytes?: number;
  }) => Promise<HostRootfsBuildLogResponse>;
  listRootfsBuilds: (opts?: {
    limit?: number;
  }) => Promise<HostRootfsBuildStatusResponse[]>;

  configuration: (
    aspect: ConfigurationAspect,
    no_cache?,
  ) => Promise<Configuration>;

  ping: () => Promise<{ now: number }>;

  exec: (opts: ExecuteCodeRequest) => Promise<ExecuteCodeOutput>;

  signal: (opts: {
    signal: number;
    pids?: number[];
    pid?: number;
  }) => Promise<void>;

  // return the ssh public key of this project.
  // The project generates a public key on startup that is used
  // internally for connecting to the file server, and this is that key.
  // Basically this is a key that is used internally for communication
  // within cocalc, so other services can trust the project.
  // It can be changed without significant consequences (the file-server
  // container gets restarted).
  sshPublicKey: () => Promise<string>;

  // calling updateSshKeys causes the project to ensure that
  // ~/.ssh/authorized_keys contains all entries set
  // in the database (in addition to whatever else might be there).
  updateSshKeys: () => Promise<string>;
}
