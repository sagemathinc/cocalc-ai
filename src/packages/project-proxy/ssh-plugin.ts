/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import getLogger from "@cocalc/backend/logger";
import { parseSshTargetUser, type SshTarget } from "./ssh-target";
import { canonicalizeSshRemoteAddr } from "./ssh-remote-addr";
import { SSHPIPER_PLUGIN_PROTO } from "./sshpiper-plugin-proto";

const logger = getLogger("project-proxy:ssh:plugin");
const CALLBACKS = ["NextAuthMethods", "PublicKeyAuth"] as const;
const SSH_AUTH_METHOD_PUBLICKEY = "PUBLICKEY" as const;
const PROTO_PATH = join(tmpdir(), "cocalc-sshpiper-plugin.proto");

type LibPluginService = grpc.ServiceDefinition<any>;

let protoReady: Promise<string> | undefined;
let serviceDefinition: LibPluginService | undefined;

export interface ManagedSshSessionIdentity {
  remote_addr: string;
  project_id: string;
  account_id?: string;
}

export interface AuthorizedSshPublicKeyResult {
  project_id: string;
  account_id?: string;
  ssh_user: string;
  port: number;
}

export interface StartManagedSshPluginServerOptions {
  proxy_private_key: string;
  authorizePublicKey: (opts: {
    remote_addr: string;
    target: SshTarget;
    public_key: Uint8Array;
  }) => Promise<AuthorizedSshPublicKeyResult>;
}

async function ensureProtoPath(): Promise<string> {
  if (!protoReady) {
    protoReady = writeFile(PROTO_PATH, SSHPIPER_PLUGIN_PROTO, "utf8").then(
      () => PROTO_PATH,
    );
  }
  return await protoReady;
}

async function getServiceDefinition(): Promise<LibPluginService> {
  if (!serviceDefinition) {
    const protoPath = await ensureProtoPath();
    const definition = protoLoader.loadSync(protoPath, {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const loaded = grpc.loadPackageDefinition(definition) as any;
    serviceDefinition = loaded?.libplugin?.SshPiperPlugin?.service;
    if (!serviceDefinition) {
      throw new Error("unable to load sshpiper plugin service definition");
    }
  }
  return serviceDefinition;
}

function grpcError(code: number, message: string): grpc.ServiceError {
  const err = new Error(message) as grpc.ServiceError;
  err.code = code;
  return err;
}

export class ManagedSshPluginState {
  private readonly sessions = new Map<string, ManagedSshSessionIdentity>();

  constructor(private readonly opts: StartManagedSshPluginServerOptions) {}

  getSession(remote_addr: string): ManagedSshSessionIdentity | undefined {
    try {
      return this.sessions.get(canonicalizeSshRemoteAddr(remote_addr));
    } catch {
      return;
    }
  }

  clearSession(remote_addr: string): void {
    try {
      this.sessions.delete(canonicalizeSshRemoteAddr(remote_addr));
    } catch {
      // ignore malformed cleanup keys
    }
  }

  listCallbacks() {
    return [...CALLBACKS];
  }

  normalizeMeta(meta: any): { from_addr: string; user_name?: string } {
    const from_addr = `${meta?.fromAddr ?? meta?.from_addr ?? ""}`.trim();
    const user_name = `${meta?.userName ?? meta?.user_name ?? ""}`.trim();
    if (!from_addr) {
      throw new Error("missing ssh connection metadata");
    }
    return user_name ? { from_addr, user_name } : { from_addr };
  }

  async nextAuthMethods(
    meta: any,
  ): Promise<readonly [typeof SSH_AUTH_METHOD_PUBLICKEY]> {
    const normalized = this.normalizeMeta(meta);
    if (normalized.user_name) {
      await this.noteProjectTarget(normalized);
    }
    return [SSH_AUTH_METHOD_PUBLICKEY];
  }

  async noteProjectTarget(meta: {
    from_addr: string;
    user_name?: string;
  }): Promise<ManagedSshSessionIdentity> {
    const remote_addr = canonicalizeSshRemoteAddr(meta.from_addr);
    if (!meta.user_name) {
      const existing = this.sessions.get(remote_addr);
      if (existing) {
        return existing;
      }
      throw new Error("missing ssh username");
    }
    const target = parseSshTargetUser(meta.user_name);
    const current = this.sessions.get(remote_addr);
    const next: ManagedSshSessionIdentity = {
      remote_addr,
      project_id: target.project_id,
      ...(current?.account_id ? { account_id: current.account_id } : {}),
    };
    this.sessions.set(remote_addr, next);
    return next;
  }

  async authorizePublicKey(opts: {
    meta: any;
    public_key: Buffer;
  }): Promise<AuthorizedSshPublicKeyResult> {
    const placeholder = await this.noteProjectTarget(
      this.normalizeMeta(opts.meta),
    );
    const target: SshTarget = {
      type: "project",
      project_id: placeholder.project_id,
    };
    const authorized = await this.opts.authorizePublicKey({
      remote_addr: placeholder.remote_addr,
      target,
      public_key: opts.public_key,
    });
    this.sessions.set(placeholder.remote_addr, {
      remote_addr: placeholder.remote_addr,
      project_id: authorized.project_id,
      ...(authorized.account_id ? { account_id: authorized.account_id } : {}),
    });
    return authorized;
  }
}

type UnaryCall<TReq, TResp> = (
  call: grpc.ServerUnaryCall<TReq, TResp>,
  callback: grpc.sendUnaryData<TResp>,
) => void | Promise<void>;

export async function startManagedSshPluginServer(
  opts: StartManagedSshPluginServerOptions,
): Promise<{
  endpoint: string;
  state: ManagedSshPluginState;
  close: () => Promise<void>;
}> {
  const service = await getServiceDefinition();
  const state = new ManagedSshPluginState(opts);
  const server = new grpc.Server();

  const unary =
    <TReq, TResp>(handler: UnaryCall<TReq, TResp>): UnaryCall<TReq, TResp> =>
    async (call, callback) => {
      try {
        await handler(call, callback);
      } catch (err) {
        logger.warn("sshpiper plugin request failed", { err: `${err}` });
        callback(
          err instanceof Error
            ? (Object.assign(err, {
                code:
                  (err as grpc.ServiceError).code ??
                  grpc.status.PERMISSION_DENIED,
              }) as grpc.ServiceError)
            : grpcError(grpc.status.PERMISSION_DENIED, `${err}`),
        );
      }
    };

  server.addService(service, {
    ListCallbacks: unary<any, any>((_call, callback) => {
      callback(null, { callbacks: state.listCallbacks() });
    }),
    NewConnection: unary<any, any>((_call, callback) => {
      callback(null, {});
    }),
    NextAuthMethods: unary<any, any>(async (call, callback) => {
      callback(null, {
        methods: await state.nextAuthMethods(call.request?.meta),
      });
    }),
    PublicKeyAuth: unary<any, any>(async (call, callback) => {
      const authorized = await state.authorizePublicKey({
        meta: call.request?.meta,
        public_key: Buffer.from(call.request?.publicKey ?? []),
      });
      callback(null, {
        upstream: {
          userName: authorized.ssh_user,
          ignoreHostKey: true,
          uri: `tcp://127.0.0.1:${authorized.port}`,
          privateKey: {
            privateKey: Buffer.from(opts.proxy_private_key, "utf8"),
          },
        },
      });
    }),
    NoneAuth: unary<any, any>((_call, callback) => {
      callback(
        grpcError(
          grpc.status.UNIMPLEMENTED,
          "none auth is not supported for CoCalc SSH ingress",
        ),
      );
    }),
    PasswordAuth: unary<any, any>((_call, callback) => {
      callback(
        grpcError(
          grpc.status.UNIMPLEMENTED,
          "password auth is not supported for CoCalc SSH ingress",
        ),
      );
    }),
    KeyboardInteractiveAuth(stream: any) {
      stream.destroy(
        grpcError(
          grpc.status.UNIMPLEMENTED,
          "keyboard-interactive auth is not supported for CoCalc SSH ingress",
        ),
      );
    },
    UpstreamAuthFailureNotice: unary<any, any>((_call, callback) => {
      callback(null, {});
    }),
    Banner: unary<any, any>((_call, callback) => {
      callback(null, { message: "" });
    }),
    VerifyHostKey: unary<any, any>((_call, callback) => {
      callback(null, { verified: true });
    }),
    PipeCreateErrorNotice: unary<any, any>((call, callback) => {
      state.clearSession(call.request?.fromAddr ?? "");
      callback(null, {});
    }),
    PipeStartNotice: unary<any, any>((_call, callback) => {
      callback(null, {});
    }),
    PipeErrorNotice: unary<any, any>((call, callback) => {
      state.clearSession(call.request?.meta?.fromAddr ?? "");
      callback(null, {});
    }),
  });

  const boundPort = await new Promise<number>((resolve, reject) => {
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (err, port) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      },
    );
  });
  server.start();

  return {
    endpoint: `127.0.0.1:${boundPort}`,
    state,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.tryShutdown(() => resolve());
      }).catch(() => undefined);
      server.forceShutdown();
    },
  };
}
