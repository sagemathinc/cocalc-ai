import { ComputeFundingError } from "@cocalc/util/compute-funding";

// Guest root access and delayed accounting cannot enforce a cloud egress cap.
// Do not enable GCP sponsorship without an external network enforcement boundary.
export function requireSponsoredVmProvider(provider: string): void {
  if (provider !== "nebius") {
    throw new ComputeFundingError(
      "funding_unavailable",
      "Course-funded GCP VMs are unavailable until provider-side network spending limits are enforced. Choose Nebius instead.",
    );
  }
}
