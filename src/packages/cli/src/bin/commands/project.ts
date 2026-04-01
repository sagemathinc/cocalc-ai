/**
 * Project command composition layer.
 *
 * This file owns shared dependency typing and registers each project
 * subcommand module (basic, ops, sync, codex, collaborators, files, lifecycle).
 */
import { Command } from "commander";
import { registerProjectSyncCommands } from "./project/sync";
import { registerProjectCodexCommands } from "./project/codex";
import { registerProjectCollabCommands } from "./project/collab";
import { registerProjectFileCommands } from "./project/file";
import { registerProjectLifecycleCommands } from "./project/lifecycle";
import { registerProjectOpsCommands } from "./project/ops";
import { registerProjectBasicCommands } from "./project/basic";
import { registerProjectAppCommands } from "./project/app";
import { registerProjectChatCommands } from "./project/chat";
import { registerProjectJupyterCommands } from "./project/jupyter";
import { registerProjectStorageCommands } from "./project/storage";

export type ProjectCommandDeps = {
  withContext: any;
  resolveHost: any;
  queryProjects: any;
  projectState: any;
  toIso: any;
  resolveProjectFromArgOrContext: any;
  resolveProject: any;
  saveProjectContext: any;
  projectContextPath: any;
  clearProjectContext: any;
  isValidUUID: any;
  confirmHardProjectDelete: any;
  waitForLro: any;
  waitForProjectNotRunning: any;
  resolveProjectSshConnection: any;
  ensureSyncKeyPair: any;
  installSyncPublicKey: any;
  runSshCheck: any;
  isLikelySshAuthFailure: any;
  runSsh: any;
  runLocalCommand: any;
  resolveCloudflaredBinary: any;
  normalizeProjectSshHostAlias: any;
  normalizeProjectSshConfigPath: any;
  projectSshConfigBlockMarkers: any;
  removeProjectSshConfigBlock: any;
  emitProjectFileCatHumanContent: any;
  waitForProjectPlacement: any;
  normalizeSyncKeyBasePath: any;
  syncKeyPublicPath: any;
  readSyncPublicKey: any;
  resolveProjectSshTarget: any;
  runReflectSyncCli: any;
  parseCreatedForwardId: any;
  listReflectForwards: any;
  reflectSyncHomeDir: any;
  reflectSyncSessionDbPath: any;
  formatReflectForwardRow: any;
  forwardsForProject: any;
  terminateReflectForwards: any;
  readAllStdin: any;
  buildCodexSessionConfig: any;
  projectCodexExecData: any;
  streamCodexHumanMessage: any;
  projectCodexAuthStatusData: any;
  durationToMs: any;
  projectCodexDeviceAuthStartData: any;
  projectCodexDeviceAuthStatusData: any;
  projectCodexDeviceAuthCancelData: any;
  projectCodexAuthUploadFileData: any;
  resolveProjectConatClient: any;
  projectChatThreadCreateData: any;
  projectChatThreadStatusData: any;
  projectChatLoopSetData: any;
  projectChatLoopClearData: any;
  projectChatAutomationData: any;
  projectChatActivityData: any;
  normalizeUserSearchName: any;
  resolveAccountByIdentifier: any;
  serializeInviteRow: any;
  compactInviteRow: any;
  globalsFrom: any;
  shouldUseDaemonForFileOps: any;
  runDaemonRequestFromCommand: any;
  emitSuccess: any;
  isDaemonTransportError: any;
  emitError: any;
  cliDebug: any;
  projectFileListData: any;
  projectFileCatData: any;
  readFileLocal: any;
  asObject: any;
  projectFilePutData: any;
  mkdirLocal: any;
  writeFileLocal: any;
  projectFileGetData: any;
  projectFileRmData: any;
  projectFileMkdirData: any;
  projectFileRgData: any;
  projectFileFdData: any;
  contextForGlobals: any;
  runProjectFileCheckBench: any;
  printArrayTable: any;
  runProjectFileCheck: any;
  closeCommandContext: any;
  resolveProxyUrl: any;
  parsePositiveInteger: any;
  isRedirect: any;
  extractCookie: any;
  fetchWithTimeout: any;
  buildCookieHeader: any;
  PROJECT_HOST_HTTP_AUTH_QUERY_PARAM: string;
  resolveProjectProjectApi: any;
  projectJupyterCellsData: any;
  projectJupyterSetCellData: any;
  projectJupyterInsertCellData: any;
  projectJupyterDeleteCellsData: any;
  projectJupyterMoveCellData: any;
  projectJupyterRunSession: any;
  projectJupyterLiveRunSession: any;
};

export function registerProjectCommand(
  program: Command,
  deps: ProjectCommandDeps,
): Command {
  const project = program.command("project").description("project operations");

  registerProjectBasicCommands(project, deps);
  registerProjectOpsCommands(project, deps);
  registerProjectSyncCommands(project, deps);
  registerProjectCodexCommands(project, deps);
  registerProjectChatCommands(project, deps);
  registerProjectJupyterCommands(project, deps);
  registerProjectCollabCommands(project, deps);
  registerProjectFileCommands(project, deps);
  registerProjectStorageCommands(project, deps);
  registerProjectLifecycleCommands(project, deps);
  registerProjectAppCommands(project, deps);

  return project;
}
