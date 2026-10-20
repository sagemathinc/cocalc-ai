import register from "./register";
import { UntrustedJavascript } from "../untrusted-javascript";

// JavaScript output is never evaluated in the app page.  In a trusted
// notebook it runs in a sandboxed frame together with the cell's HTML output
// (see ../active-output-group.tsx), so this renderer is only reached when it
// is not run at all.
register("application/javascript", 2.5, () => {
  return <UntrustedJavascript />;
});
