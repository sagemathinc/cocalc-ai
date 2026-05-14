/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getParams from "@cocalc/http-api/lib/api/get-params";
import { startSignInPasskeyAuthentication } from "@cocalc/server/auth/passkeys";

export default async function startPasskeyAuthenticationApi(req, res) {
  try {
    const { challenge_id } = getParams(req);
    res.json(
      await startSignInPasskeyAuthentication({
        req,
        challenge_id,
      }),
    );
  } catch (err) {
    res.json({
      error:
        err instanceof Error
          ? err.message
          : "Problem starting passkey authentication.",
    });
  }
}
