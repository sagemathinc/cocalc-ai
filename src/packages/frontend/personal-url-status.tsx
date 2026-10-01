import { useEffect, useRef, useState } from "react";
import { Alert, Button } from "antd";
import { ProjectAccessDialog } from "@cocalc/frontend/project/access";
import { resolvePersonalUrl } from "./personal-url-navigation";

/** No content locator or resource title is needed to request project access. */
export function PersonalUrlStatus({
  url,
  loading,
  error,
  projectId,
}: {
  url: string;
  loading: boolean;
  error?: string;
  projectId?: string;
}) {
  const [accessOpen, setAccessOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [url]);
  return (
    <section
      aria-label="Personal alias"
      style={{ padding: 20, minWidth: 0, overflowWrap: "anywhere" }}
    >
      <h2 ref={heading} tabIndex={-1}>
        Personal alias
      </h2>
      {loading ? (
        <p role="status">Resolving personal alias...</p>
      ) : (
        <Alert
          role="alert"
          type="warning"
          title={
            projectId ? "Project access required" : "Personal alias unavailable"
          }
          description={error}
        />
      )}
      <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
        {projectId && !loading && (
          <Button
            style={{ maxWidth: "100%", height: "auto", whiteSpace: "normal" }}
            onClick={() => setAccessOpen(true)}
          >
            Request access
          </Button>
        )}
        <Button
          style={{ maxWidth: "100%", height: "auto", whiteSpace: "normal" }}
          disabled={loading}
          onClick={() => void resolvePersonalUrl(url)}
        >
          Retry personal link
        </Button>
      </div>
      {projectId && (
        <ProjectAccessDialog
          projectId={projectId}
          open={accessOpen}
          onClose={() => setAccessOpen(false)}
          onAccessGranted={async () => {
            setAccessOpen(false);
            await resolvePersonalUrl(url);
          }}
        />
      )}
    </section>
  );
}
