import { useEffect } from "react";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { authViewUrl } from "./util";

export default function AuthPage() {
  const auth_view = useTypedRedux("page", "auth_view") ?? "sign-in";
  const href = authViewUrl(auth_view);

  useEffect(() => {
    window.location.href = href;
  }, [href]);

  return <a href={href}>Continue to authentication</a>;
}
