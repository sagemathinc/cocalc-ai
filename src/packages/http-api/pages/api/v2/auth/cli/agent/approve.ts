import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import isPost from "@cocalc/http-api/lib/api/is-post";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import { approveExternalAgentLogin } from "@cocalc/server/agents/external";
import assertSameOriginMutation from "@cocalc/http-api/lib/api/assert-same-origin-mutation";

export default async function externalAgentApprove(req, res) {
  if (!isPost(req, res)) return;
  try {
    if (req.header("Authorization"))
      throw new Error("API keys cannot approve external agent login");
    assertSameOriginMutation(req);
    const account_id = await getAccountId(req),
      session_hash = getRememberMeHash(req);
    if (!account_id || !session_hash) throw new Error("must be signed in");
    const {
      origin_bay_id,
      challenge_id,
      agent_session_id,
      ttl_seconds,
      agent_id,
    } = getParams(req);
    res.json(
      await approveExternalAgentLogin({
        account_id,
        session_hash,
        origin_bay_id,
        challenge_id,
        agent_session_id,
        ttl_seconds,
        agent_id,
      }),
    );
  } catch (error) {
    res.json({
      error: `${error instanceof Error ? error.message : error}`,
      ...((error as any)?.code ? { code: (error as any).code } : {}),
    });
  }
}
