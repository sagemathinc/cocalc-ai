/*
Returns information about a given license, which
the user with the given account is *allowed* to get.
*/

const unsupportedSiteLicenses = (): never => {
  throw new Error("Site licenses are not supported in this fork.");
};

export async function isManager(
  license_id: string,
  account_id?: string,
): Promise<boolean> {
  void license_id;
  void account_id;
  return false;
}

export default async function getLicense(
  license_id: string,
  account_id?: string,
): Promise<never> {
  void license_id;
  void account_id;
  return unsupportedSiteLicenses();
}

export async function getLicenseBySubscriptionId(
  subscription_id: string,
  account_id: string,
): Promise<never> {
  void subscription_id;
  void account_id;
  return unsupportedSiteLicenses();
}
