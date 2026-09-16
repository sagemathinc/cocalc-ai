import { Alert, Button, Space } from "antd";
import { useEffect, useRef, useState } from "react";
import type { CodexModelCapabilityInfo } from "@cocalc/conat/hub/api/system";
import {
  discoverAccountCodexModels,
  preferredAvailableCodexModel,
} from "./codex-model-discovery";

export function CodexModelRecovery({
  projectId,
  failedModel,
  details,
  onRetry,
}: {
  projectId: string;
  failedModel: string;
  details: string;
  onRetry: (model: string) => Promise<void>;
}) {
  const [models, setModels] = useState<CodexModelCapabilityInfo[]>();
  const [selected, setSelected] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setModels(undefined);
    setSelected(undefined);
    setError("");
    void discoverAccountCodexModels(projectId, undefined, true)
      .then((catalog) => {
        if (cancelled) return;
        setModels(catalog?.filter(({ model }) => model !== failedModel));
        setSelected(
          preferredAvailableCodexModel(catalog, undefined, failedModel)?.model,
        );
      })
      .catch(() => {
        if (!cancelled)
          setError(
            "We couldn't check your available models. Please try checking again.",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, failedModel, refresh]);
  const chosen = models?.find(({ model }) => model === selected);
  async function retry() {
    if (!chosen || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await onRetry(chosen.model);
    } catch {
      setError(
        "We couldn't retry this request. Please check the conversation's model settings and try again.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return (
    <Alert
      type="info"
      showIcon
      title="Let's use a model available with your account."
      description={
        <Space orientation="vertical" style={{ width: "100%" }}>
          <div>
            {failedModel} isn't available with your connected ChatGPT account.
            Your original request is ready to retry.
          </div>
          <div role="status" aria-live="polite">
            {loading
              ? "Finding an available model..."
              : error ||
                (!chosen
                  ? "No alternative model was found. Check your Agent model settings or refresh the list."
                  : "This uses your ChatGPT plan, not an API key. Model-specific reasoning and speed settings will reset.")}
          </div>
          {chosen ? (
            <>
              <label>
                Available model{" "}
                <select
                  value={selected}
                  disabled={busy}
                  onChange={(e) => setSelected(e.target.value)}
                  style={{ maxWidth: "100%" }}
                >
                  {models?.map(({ model, displayName }) => (
                    <option key={model} value={model}>
                      {displayName || model}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                type="primary"
                loading={busy}
                onClick={() => void retry()}
                style={{ whiteSpace: "normal", height: "auto" }}
              >
                Use {chosen.displayName || chosen.model} and retry
              </Button>
            </>
          ) : (
            <Button disabled={loading} onClick={() => setRefresh((n) => n + 1)}>
              Check available models again
            </Button>
          )}
          <details>
            <summary>Technical details</summary>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {details}
            </pre>
          </details>
        </Space>
      }
    />
  );
}
