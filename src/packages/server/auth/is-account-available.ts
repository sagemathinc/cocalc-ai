import { getClusterAccountByEmail } from "@cocalc/server/inter-bay/accounts";

export default async function isAccountAvailable(
  email_address: string,
): Promise<boolean> {
  return (await getClusterAccountByEmail(email_address)) == null;
}
