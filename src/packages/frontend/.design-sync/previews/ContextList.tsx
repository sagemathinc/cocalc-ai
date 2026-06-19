import { ContextList, DSProvider } from "@cocalc/frontend";

// ContextList — a left-bordered vertical list (optional title + Icon/label
// rows) used in feature-page "Project context" sidebars. `items` (array of
// { icon: IconName; label: ReactNode }) is required; `title` and `accent`
// (tints the left border + icons) are optional. WithoutTitle exercises the
// title-omitted branch. Each cell is width-constrained (~280px) like its column.

export const JuliaContext = () => (
  <DSProvider>
    <div style={{ width: 280 }}>
      <ContextList
        accent="#9558b2"
        title="Project context"
        items={[
          { icon: "jupyter", label: "Collaborative Jupyter notebooks" },
          { icon: "layout", label: "Pluto for reactive notebooks" },
          { icon: "terminal", label: "Julia packages and scripts in a shell" },
          { icon: "python", label: "Mix with Python, R, and shell tools" },
        ]}
      />
    </div>
  </DSProvider>
);

export const RContext = () => (
  <DSProvider>
    <div style={{ width: 280 }}>
      <ContextList
        accent="#386cb0"
        title="Project context"
        items={[
          { icon: "r", label: "Model, analyze, and report in R" },
          { icon: "python", label: "Mix with Python or shell tools" },
          { icon: "tex", label: "Publish with LaTeX, Rmd, Qmd, or Knitr" },
          { icon: "graduation-cap", label: "Teach in shared project environments" },
        ]}
      />
    </div>
  </DSProvider>
);

export const SageContext = () => (
  <DSProvider>
    <div style={{ width: 280 }}>
      <ContextList
        accent="#389e0d"
        title="Project context"
        items={[
          { icon: "file", label: "Keep source files" },
          { icon: "terminal", label: "Run project commands" },
          { icon: "bug", label: "Inspect errors" },
          { icon: "robot", label: "Use Codex with context" },
        ]}
      />
    </div>
  </DSProvider>
);

export const WithoutTitle = () => (
  <DSProvider>
    <div style={{ width: 280 }}>
      <ContextList
        accent="#389e0d"
        items={[
          { icon: "file", label: "Keep source files" },
          { icon: "terminal", label: "Run project commands" },
          { icon: "bug", label: "Inspect errors" },
          { icon: "robot", label: "Use Codex with context" },
        ]}
      />
    </div>
  </DSProvider>
);
