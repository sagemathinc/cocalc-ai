/*
Returns array of projects with a given license applied to them, including the following info:

- project_id
- title: of project
- quota: what upgrades from license are being used right now, if any
- last_edited: when project last_edited
- collaborators: account_id's of collaborators on the project
*/

const unsupportedSiteLicenses = (): never => {
  throw new Error("Site licenses are not supported in this fork.");
};

export interface Project {
  project_id: string;
  title: string;
  quota: object;
  last_edited: number; // ms since epoch
  state?: unknown;
  collaborators: string[];
}

export default async function getProjectsWithLicense(
  license_id: string,
): Promise<never> {
  void license_id;
  return unsupportedSiteLicenses();
}
