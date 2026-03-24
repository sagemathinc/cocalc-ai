import { useTypedRedux } from "@cocalc/frontend/app-framework";
import type { AuthView } from "./types";
import SignUpFormBase from "./sign-up-base";

interface SignUpProps {
  onNavigate: (view: AuthView) => void;
}

export default function SignUpForm({ onNavigate }: SignUpProps) {
  const tokenFromStore = useTypedRedux("account", "token");
  return (
    <SignUpFormBase
      onNavigate={onNavigate}
      initialRequiresToken={tokenFromStore}
    />
  );
}
