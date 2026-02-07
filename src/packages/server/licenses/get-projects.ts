/*
Returns array of such projects, with the following fields:

- project_id
- title
- map from license_id to what is being used right now
- last_edited
- if project is hidden
- project state, e.g., 'running'
*/

const unsupportedSiteLicenses = (): never => {
  throw new Error("Site licenses are not supported in this fork.");
};

export interface Project {
  project_id: string;
  title: string;
  site_license: object;
  hidden?: boolean;
  last_edited: number; // ms since epoch
  state?: unknown;
}

export default async function getProjects(account_id: string): Promise<never> {
  void account_id;
  return unsupportedSiteLicenses();
}
