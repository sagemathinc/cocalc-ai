export const authFirst = ({
  args,
  account_id,
  project_id,
  host_id,
  auth_session_hash,
}) => {
  if (args[0] == null) {
    args[0] = {} as any;
  }
  if (account_id) {
    args[0].account_id = account_id;
  } else if (project_id) {
    args[0].project_id = project_id;
  } else if (host_id) {
    args[0].host_id = host_id;
  }
  if (auth_session_hash && args[0].session_hash == null) {
    args[0].session_hash = auth_session_hash;
  }
  return args;
};

export const noAuth = ({ args }) => args;

// make no changes, except throw error if account_id not set (i.e., user not signed in with an account)
export const requireAccount = ({ args, account_id }) => {
  if (!account_id) {
    throw Error("user must be signed in with an account");
  }
  return args;
};

export const authFirstRequireAccount = async ({
  args,
  account_id,
  auth_actor,
  auth_session_hash,
}) => {
  if (args[0] == null) {
    args[0] = {} as any;
  }
  if (!account_id || auth_actor === "agent") {
    throw Error("user must be signed in");
  }
  args[0].account_id = account_id;
  if (auth_session_hash && args[0].session_hash == null) {
    args[0].session_hash = auth_session_hash;
  }
  return args;
};

export const authFirstRequireProject = async ({ args, project_id }) => {
  if (args[0] == null) {
    args[0] = {} as any;
  }
  if (!project_id) {
    throw Error("must be a project");
  }
  args[0].project_id = project_id;
  return args;
};

export const authFirstRequireHost = async ({ args, host_id }) => {
  if (args[0] == null) {
    args[0] = {} as any;
  }
  if (!host_id) {
    throw Error("must be a host");
  }
  args[0].host_id = host_id;
  return args;
};

export const authFirstRequireProjectOrHost = async ({
  args,
  project_id,
  host_id,
}) => {
  if (args[0] == null) {
    args[0] = {} as any;
  }
  if (host_id) {
    args[0].host_id = host_id;
    return args;
  }
  if (project_id) {
    delete args[0].host_id;
    delete args[0].account_id;
    args[0].project_id = project_id;
    return args;
  }
  throw Error("must be a project or host");
};

export const authFirstRequireComputeProject = async ({
  args,
  account_id,
  project_id,
  host_id,
  auth_actor,
  auth_token_fingerprint,
  auth_iat_s,
  auth_exp_s,
}) => {
  if (args[0] == null) args[0] = {} as any;
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
    delete args[0].account_id;
    delete args[0].host_id;
    args[0].project_id = project_id;
    args[0].agent_auth = {
      account_id,
      project_id,
      token_fingerprint: auth_token_fingerprint,
      issued_at_s: auth_iat_s,
      expires_at_s: auth_exp_s,
    };
    return args;
  }
  return await authFirstRequireProjectOrHost({ args, project_id, host_id });
};

export const authFirstRequireAccountOrComputeProject = async (context) => {
  if (context.auth_actor === "agent") {
    return await authFirstRequireComputeProject(context);
  }
  if (context.account_id) {
    if (context.args[0] == null) context.args[0] = {} as any;
    const projectId = `${context.args[0].project_id ?? ""}`.trim();
    if (!projectId) throw new Error("project_id is required");
    delete context.args[0].host_id;
    delete context.args[0].agent_auth;
    context.args[0].account_id = context.account_id;
    if (context.auth_session_hash && context.args[0].session_hash == null) {
      context.args[0].session_hash = context.auth_session_hash;
    }
    return context.args;
  }
  if (context.args[0] != null) {
    delete context.args[0].account_id;
    delete context.args[0].agent_auth;
  }
  return await authFirstRequireComputeProject(context);
};

export const authFirstRequireAccountOrComputeAgent = async (context) => {
  if (context.auth_actor === "agent") {
    return await authFirstRequireComputeProject(context);
  }
  return await authFirstRequireAccount(context);
};
