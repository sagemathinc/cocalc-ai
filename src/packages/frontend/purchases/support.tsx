import { Button } from "antd";
import getSupportURL from "@cocalc/frontend/support/url";

export default function Support({ children, style }: { children; style? }) {
  return (
    <Button
      type="link"
      href={getSupportURL({
        body: "",
        subject: "Request: Pay As You Go Billing Help",
        type: "question",
        hideExtra: true,
      })}
      target="_blank"
      style={style}
    >
      {children}
    </Button>
  );
}
