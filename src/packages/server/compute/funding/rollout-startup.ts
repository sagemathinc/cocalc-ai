import { registerFundingRolloutVerifier } from "./rollout";
import { verifyIsolatedQaFundingWriter } from "./isolated-qa-rollout";
import { verifyProductionFundingRollout } from "./production-rollout";

let unregister: (() => void) | undefined;

/** The isolated development operating model requires live inspection, not just
 * an enable flag. Production verifies an operator-signed deployment census plus
 * current database privileges and configured resource credential identities.
 */
export function initFundingRolloutVerifiers(): void {
  if (unregister) return;
  const isolated = process.env.COCALC_FUNDING_ISOLATED_QA === "yes";
  const account = registerFundingRolloutVerifier(
    "account-holds",
    isolated
      ? verifyIsolatedQaFundingWriter
      : () => verifyProductionFundingRollout("account-holds"),
  );
  try {
    const resources = registerFundingRolloutVerifier(
      "sponsored-resources",
      isolated
        ? verifyIsolatedQaFundingWriter
        : () => verifyProductionFundingRollout("sponsored-resources"),
    );
    unregister = () => {
      resources();
      account();
    };
  } catch (error) {
    account();
    throw error;
  }
}

export function stopFundingRolloutVerifiers(): void {
  unregister?.();
  unregister = undefined;
}
