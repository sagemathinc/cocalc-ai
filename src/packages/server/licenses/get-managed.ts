/*
Returns array of licenses that a given user manages.
*/

const unsupportedSiteLicenses = (): never => {
  throw new Error("Site licenses are not supported in this fork.");
};

export default async function getManagedLicenses(
  account_id: string,
  limit?: number,
  offset?: number,
): Promise<never> {
  void account_id;
  void limit;
  void offset;
  return unsupportedSiteLicenses();
}
