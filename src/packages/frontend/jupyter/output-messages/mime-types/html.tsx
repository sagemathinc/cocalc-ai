import register from "./register";
import HTML from "@cocalc/frontend/components/html-ssr";
import { LegacyHtmlOutputContext } from "../../notebook-file-context";

export default function Html({
  value,
}: {
  value: string;
  id?: string;
  index?: number;
  trust?: boolean;
}) {
  return (
    <LegacyHtmlOutputContext>
      <HTML value={value} />
    </LegacyHtmlOutputContext>
  );
}

// HTML should definitely have higher priority than
// LaTeX.  For example, Julia tables are output as both
// **backend only** text/latex and as text/html
// that looks good and is meant to be rendered on the frontend.
// See https://github.com/sagemathinc/cocalc/issues/5925
// But Latex should have higher priority than HTML, e.g.,
// sage show(...) is much better to just render using latex!
// SIGH.
register("text/html", 5, Html);
