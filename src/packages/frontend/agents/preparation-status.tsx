import { useEffect, useState } from "react";
import {
  ONBOARDING_PHASES,
  ONBOARDING_STALLED_MS,
  type OnboardingPhase,
} from "@cocalc/util/onboarding-metrics";

/** Reserve one line so starting preparation does not move the prompt field. */
export function PreparationStatus({
  active,
  phase,
}: {
  active: boolean;
  phase: OnboardingPhase;
}) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setSeconds(0);
    if (!active) return;
    const start = Date.now();
    const timer = setInterval(
      () => setSeconds(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [active]);
  return (
    <div style={{ minHeight: 24 }}>
      <span role="status" aria-live="polite" aria-atomic="true">
        {active ? ONBOARDING_PHASES[phase] : ""}
      </span>
      {active && seconds >= 10 && <span aria-hidden="true"> ({seconds}s)</span>}
      {active && seconds * 1000 >= ONBOARDING_STALLED_MS && (
        <div role="status">
          This is taking longer than expected. The delay is being recorded.
        </div>
      )}
    </div>
  );
}
