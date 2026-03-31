import { render } from "./register";
import StaticCodeBlock from "@cocalc/frontend/components/static-code-block";
import infoToMode from "@cocalc/frontend/editors/slate/elements/code-block/info-to-mode";

render({ type: "json" }, ({ field, obj }) => {
  const json = obj[field];
  if (!json) return null;
  return (
    <StaticCodeBlock
      style={{ maxHeight: "10em", overflow: "auto" }}
      value={JSON.stringify(obj[field], undefined, 2)}
      info={infoToMode("js")}
    />
  );
});

render({ type: "json-string" }, ({ field, obj }) => {
  const json = obj[field];
  if (!json) return null;
  let parsed;
  try {
    parsed = JSON.parse(obj[field]);
  } catch (_) {
    parsed = obj[field];
  }
  return (
    <StaticCodeBlock
      style={{ maxHeight: "10em", overflow: "auto" }}
      value={JSON.stringify(parsed, undefined, 2)}
      info={infoToMode("js")}
    />
  );
});
