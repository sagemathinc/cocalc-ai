import { render } from "./register";
import StaticCodeBlock from "@cocalc/frontend/components/static-code-block";
import infoToMode from "@cocalc/frontend/editors/slate/elements/code-block/info-to-mode";

render({ type: "code" }, ({ field, obj }) => {
  const code = obj[field];
  if (!code) return null;
  return (
    <StaticCodeBlock value={code} info={infoToMode("", { value: code })} />
  );
});
