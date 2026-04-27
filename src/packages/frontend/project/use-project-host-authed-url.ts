import { React } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export function useProjectHostAuthedUrl({
  project_id,
  url,
}: {
  project_id: string;
  url?: string;
}): string | undefined {
  const [authedUrl, setAuthedUrl] = React.useState<string | undefined>(
    undefined,
  );

  React.useEffect(() => {
    let canceled = false;
    if (!url) {
      setAuthedUrl(undefined);
      return;
    }
    setAuthedUrl(undefined);
    void (async () => {
      try {
        await webapp_client.conat_client.ensureProjectHostBrowserSessionForProject(
          {
            project_id,
          },
        );
        const next = await webapp_client.conat_client.routeProjectHostHttpUrl({
          project_id,
          url,
        });
        if (!canceled) {
          setAuthedUrl(next);
        }
      } catch {
        if (!canceled) {
          setAuthedUrl(url);
        }
      }
    })();
    return () => {
      canceled = true;
    };
  }, [project_id, url]);

  return authedUrl;
}
