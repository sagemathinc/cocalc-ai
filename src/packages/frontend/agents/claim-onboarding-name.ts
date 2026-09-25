import { uuid } from "@cocalc/util/misc";

/** Claim, rather than preflight, so concurrent tabs cannot race availability. */
export async function claimOnboardingName<T>(
  preferred: string,
  claim: (name: string) => Promise<T>,
): Promise<{ name: string; result: T }> {
  let name = preferred;
  for (let attempt = 0; ; attempt++) {
    try {
      return { name, result: await claim(name) };
    } catch (error) {
      // Only a definite naming conflict permits another claim. A timeout may
      // mean the original claim succeeded; leave reconciliation to retry.
      if (!/\bname_reserved\b/.test(String(error)) || attempt >= 10)
        throw error;
      name =
        attempt === 0
          ? "agent-1"
          : `agent-${uuid().replace(/-/g, "").slice(0, 24)}`;
    }
  }
}
