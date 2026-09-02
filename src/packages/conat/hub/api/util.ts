export type HubApiPrincipalPolicy =
  | "public"
  | "account"
  | "project"
  | "host"
  | "project-or-host"
  | "account-or-project"
  | "account-or-host"
  | "account-or-project-or-host"
  | "authenticated"
  | "compute-project"
  | "account-or-compute-project"
  | "account-or-compute-agent";

export interface HubApiArgTransformContext {
  args: any[];
  account_id?: string;
  project_id?: string;
  host_id?: string;
  auth_actor?: "agent";
  auth_session_hash?: string | null;
  auth_token_fingerprint?: string;
  auth_iat_s?: number;
  auth_exp_s?: number;
}

export type HubApiArgTransform = ((
  context: HubApiArgTransformContext,
) => any[] | Promise<any[]>) & {
  principalPolicy: HubApiPrincipalPolicy;
  preservesAccountTarget: boolean;
};

export function declareHubApiPrincipalPolicy(
  principalPolicy: HubApiPrincipalPolicy,
  transform: (context: HubApiArgTransformContext) => any[] | Promise<any[]>,
  { preservesAccountTarget = false }: { preservesAccountTarget?: boolean } = {},
): HubApiArgTransform {
  return Object.assign(transform, {
    principalPolicy,
    preservesAccountTarget,
  });
}

function firstArg(args: any[]): any {
  if (args[0] == null) {
    args[0] = {} as any;
  }
  return args[0];
}

function bindAccount({
  args,
  account_id,
  auth_session_hash,
}: HubApiArgTransformContext): any[] {
  const opts = firstArg(args);
  opts.account_id = account_id;
  if (auth_session_hash && opts.session_hash == null) {
    opts.session_hash = auth_session_hash;
  }
  return args;
}

function bindProject({ args, project_id }: HubApiArgTransformContext): any[] {
  const opts = firstArg(args);
  // Generic Hub transforms treat account_id as the actor identity. Methods
  // where it is instead a target must use a reviewed custom transform.
  delete opts.account_id;
  delete opts.host_id;
  opts.project_id = project_id;
  return args;
}

function bindHost({ args, host_id }: HubApiArgTransformContext): any[] {
  const opts = firstArg(args);
  // A host may retain a project_id as the resource it is acting on, but it
  // must never nominate an account actor.
  delete opts.account_id;
  opts.host_id = host_id;
  return args;
}

export const noAuth = declareHubApiPrincipalPolicy(
  "public",
  ({ args }) => args,
);

// Make no changes, except throw if the caller is not an account principal.
export const requireAccount = declareHubApiPrincipalPolicy(
  "account",
  ({ args, account_id, auth_actor }) => {
    if (!account_id || auth_actor === "agent") {
      throw Error("user must be signed in with an account");
    }
    return args;
  },
);

export const authFirstRequireAccount = declareHubApiPrincipalPolicy(
  "account",
  async (context) => {
    if (!context.account_id || context.auth_actor === "agent") {
      throw Error("user must be signed in");
    }
    return bindAccount(context);
  },
);

export const authFirstRequireProject = declareHubApiPrincipalPolicy(
  "project",
  async (context) => {
    if (!context.project_id || context.auth_actor === "agent") {
      throw Error("must be a project");
    }
    return bindProject(context);
  },
);

export const authFirstRequireHost = declareHubApiPrincipalPolicy(
  "host",
  async (context) => {
    if (!context.host_id || context.auth_actor === "agent") {
      throw Error("must be a host");
    }
    return bindHost(context);
  },
);

// Use only when account_id is data/attribution for a host-authorized action,
// never when downstream code treats it as the authenticated actor.
export const authFirstRequireHostWithAccountTarget =
  declareHubApiPrincipalPolicy(
    "host",
    async (context) => {
      if (!context.host_id || context.auth_actor === "agent") {
        throw Error("must be a host");
      }
      const opts = firstArg(context.args);
      opts.host_id = context.host_id;
      return context.args;
    },
    { preservesAccountTarget: true },
  );

export const authFirstRequireProjectOrHost = declareHubApiPrincipalPolicy(
  "project-or-host",
  async (context) => {
    if (context.auth_actor === "agent") {
      throw Error("must be a project or host");
    }
    if (context.host_id) {
      return bindHost(context);
    }
    if (context.project_id) {
      return bindProject(context);
    }
    throw Error("must be a project or host");
  },
);

export const authFirstRequireAccountOrProject = declareHubApiPrincipalPolicy(
  "account-or-project",
  async (context) => {
    if (context.auth_actor === "agent") {
      throw Error("must be an account or project");
    }
    if (context.account_id) {
      return bindAccount(context);
    }
    if (context.project_id) {
      return bindProject(context);
    }
    throw Error("must be an account or project");
  },
);

export const authFirstRequireAccountOrHost = declareHubApiPrincipalPolicy(
  "account-or-host",
  async (context) => {
    if (context.auth_actor === "agent") {
      throw Error("must be an account or host");
    }
    if (context.account_id) {
      return bindAccount(context);
    }
    if (context.host_id) {
      return bindHost(context);
    }
    throw Error("must be an account or host");
  },
);

// As above, but account_id is a target when the authenticated principal is a
// host. Account callers are still rebound to their authenticated identity.
export const authFirstRequireAccountOrHostWithAccountTarget =
  declareHubApiPrincipalPolicy(
    "account-or-host",
    async (context) => {
      if (context.auth_actor === "agent") {
        throw Error("must be an account or host");
      }
      if (context.account_id) {
        return bindAccount(context);
      }
      if (context.host_id) {
        const opts = firstArg(context.args);
        opts.host_id = context.host_id;
        return context.args;
      }
      throw Error("must be an account or host");
    },
    { preservesAccountTarget: true },
  );

export const authFirstRequireAccountOrProjectOrHost =
  declareHubApiPrincipalPolicy(
    "account-or-project-or-host",
    async (context) => {
      if (context.auth_actor === "agent") {
        throw Error("must be an account, project, or host");
      }
      if (context.account_id) {
        return bindAccount(context);
      }
      if (context.project_id) {
        return bindProject(context);
      }
      if (context.host_id) {
        return bindHost(context);
      }
      throw Error("must be an account, project, or host");
    },
  );

// Managed compute agents need this during bootstrap. Bind them to their
// project identity rather than their owning account identity.
export const authFirstRequireAuthenticated = declareHubApiPrincipalPolicy(
  "authenticated",
  async (context) => {
    if (context.auth_actor === "agent") {
      if (!context.project_id) throw Error("must be authenticated");
      return bindProject(context);
    }
    if (context.account_id) return bindAccount(context);
    if (context.project_id) return bindProject(context);
    if (context.host_id) return bindHost(context);
    throw Error("must be authenticated");
  },
);

export const authFirstRequireComputeProject = declareHubApiPrincipalPolicy(
  "compute-project",
  async (context) => {
    const {
      args,
      account_id,
      project_id,
      auth_actor,
      auth_token_fingerprint,
      auth_iat_s,
      auth_exp_s,
    } = context;
    if (auth_actor === "agent") {
      if (
        !account_id ||
        !project_id ||
        !auth_token_fingerprint ||
        !auth_iat_s ||
        !auth_exp_s
      ) {
        throw new Error("invalid managed-compute agent identity");
      }
      const opts = firstArg(args);
      delete opts.account_id;
      delete opts.host_id;
      opts.project_id = project_id;
      opts.agent_auth = {
        account_id,
        project_id,
        token_fingerprint: auth_token_fingerprint,
        issued_at_s: auth_iat_s,
        expires_at_s: auth_exp_s,
      };
      return args;
    }
    return await authFirstRequireProjectOrHost(context);
  },
);

export const authFirstRequireAccountOrComputeProject =
  declareHubApiPrincipalPolicy(
    "account-or-compute-project",
    async (context) => {
      if (context.auth_actor === "agent") {
        return await authFirstRequireComputeProject(context);
      }
      if (context.account_id) {
        const opts = firstArg(context.args);
        const projectId = `${opts.project_id ?? ""}`.trim();
        if (!projectId) throw new Error("project_id is required");
        delete opts.host_id;
        delete opts.agent_auth;
        return bindAccount(context);
      }
      if (context.args[0] != null) {
        delete context.args[0].account_id;
        delete context.args[0].agent_auth;
      }
      return await authFirstRequireComputeProject(context);
    },
  );

export const authFirstRequireAccountOrComputeAgent =
  declareHubApiPrincipalPolicy("account-or-compute-agent", async (context) => {
    if (context.auth_actor === "agent") {
      return await authFirstRequireComputeProject(context);
    }
    return await authFirstRequireAccount(context);
  });
