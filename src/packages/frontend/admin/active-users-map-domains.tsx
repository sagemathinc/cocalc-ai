/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ActiveUserMapEmailDomainCount } from "@cocalc/conat/hub/api/system";
import Plot from "@cocalc/frontend/components/plotly";
import { COLORS } from "@cocalc/util/theme";

export function activeUsersMapDomainColors(
  counts: ActiveUserMapEmailDomainCount[],
): string[] {
  const colors = counts.map(({ domain }, index) =>
    domain === "Other"
      ? COLORS.GRAY
      : COLORS.CATEGORICAL[index % COLORS.CATEGORICAL.length],
  );
  const last = colors.length - 1;
  if (last > 0 && colors[last] === colors[0]) {
    colors[last] =
      COLORS.CATEGORICAL.find(
        (color) => color !== colors[0] && color !== colors[last - 1],
      ) ?? COLORS.GRAY;
  }
  return colors;
}

function accessibilitySummary(
  counts: ActiveUserMapEmailDomainCount[],
  total: number,
): string {
  const userLabel = total === 1 ? "user" : "users";
  return `Email domains for ${total} active ${userLabel}: ${counts
    .map(({ domain, count }) => `${domain}, ${count}`)
    .join("; ")}.`;
}

export function ActiveUsersMapDomainChart({
  counts,
  total,
}: {
  counts: ActiveUserMapEmailDomainCount[];
  total: number;
}) {
  if (total === 0) return null;
  const labels = counts.map(({ domain }) => domain);
  const values = counts.map(({ count }) => count);
  const colors = activeUsersMapDomainColors(counts);

  const commonTrace = {
    type: "pie" as const,
    labels,
    values,
    sort: false,
    direction: "clockwise" as const,
    rotation: 135,
    marker: { colors },
    showlegend: false,
    automargin: true,
  };

  return (
    <div role="img" aria-label={accessibilitySummary(counts, total)}>
      <Plot
        data={[
          {
            ...commonTrace,
            texttemplate: "%{label}",
            textposition: "outside",
            hoverinfo: "skip",
          },
          {
            ...commonTrace,
            texttemplate: "%{value:d}",
            textposition: "inside",
            hovertemplate:
              "%{label}: %{value:d} active users (%{percent})<extra></extra>",
          },
        ]}
        layout={{
          height: 520,
          paper_bgcolor: "transparent",
          plot_bgcolor: "transparent",
          showlegend: false,
        }}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: "100%" }}
      />
    </div>
  );
}
