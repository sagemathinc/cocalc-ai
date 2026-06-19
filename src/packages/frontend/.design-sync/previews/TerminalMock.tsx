import { DSProvider, TerminalMock } from "@cocalc/frontend";

// TerminalMock — a self-contained dark (#0b1522) terminal panel: a header bar
// with traffic-light dots + title, then a monospace column of `rows` whose
// lines alternate blue/green. `rows` (ReactNode[], one line each) is required;
// `title` is optional and defaults to "terminal". Default exercises that
// default; CoCalcTerminal passes a custom title. Rows use the terminal-page
// command/host content from the guide.

export const Default = () => (
  <DSProvider>
    <TerminalMock
      rows={[
        "alice@project $ python run.py",
        "Running analysis...",
        "Results written to results.csv",
        "ben@project $ open notes.md",
        "codex@project $ gh pr status",
      ]}
    />
  </DSProvider>
);

export const CoCalcTerminal = () => (
  <DSProvider>
    <TerminalMock
      title="CoCalc Terminal"
      rows={[
        "alice@project $ python run.py",
        "Running analysis...",
        "Results written to results.csv",
        "ben@project $ open notes.md",
        "codex@project $ gh pr status",
      ]}
    />
  </DSProvider>
);
