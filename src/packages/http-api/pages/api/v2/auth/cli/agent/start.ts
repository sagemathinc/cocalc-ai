import getParams from "@cocalc/http-api/lib/api/get-params";
import isPost from "@cocalc/http-api/lib/api/is-post";
import { startExternalAgentLoginChallenge } from "@cocalc/server/auth/cli-auth";

export default async function externalAgentStart(req, res) {
  if (!isPost(req, res)) return;
  try {
    const { label, secret_hash } = getParams(req);
    res.json(
      await startExternalAgentLoginChallenge({ req, label, secret_hash }),
    );
  } catch (error) {
    res.json({ error: `${error instanceof Error ? error.message : error}` });
  }
}
