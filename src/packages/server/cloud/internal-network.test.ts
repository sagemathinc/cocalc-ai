import { gcpInternalHostname } from "@cocalc/cloud";
import {
  resolveGcpInternalConatUrl,
  resolveGcpManagedHostInternalUrl,
  resolveGcpRuntimeInternalHostname,
} from "./internal-network";

describe("gcp internal network helpers", () => {
  it("derives the stable internal hostname from instance and project id", () => {
    expect(
      gcpInternalHostname({
        instanceName: "alpha-557fb6cc-c840-45c7-b578-79ccad2960d1",
        projectId: "projecthosts",
      }),
    ).toBe(
      "alpha-557fb6cc-c840-45c7-b578-79ccad2960d1.c.projecthosts.internal",
    );
  });

  it("uses runtime internal hostname when present", () => {
    expect(
      resolveGcpRuntimeInternalHostname({
        provider: "gcp",
        instance_id: "ignored",
        ssh_user: "ubuntu",
        internal_hostname: "host-a.c.proj-1.internal",
      }),
    ).toBe("host-a.c.proj-1.internal");
  });

  it("derives runtime internal hostname from stored GCP metadata", () => {
    expect(
      resolveGcpRuntimeInternalHostname({
        provider: "gcp",
        instance_id: "host-a",
        ssh_user: "ubuntu",
        metadata: { gcp_project_id: "proj-1" },
      }),
    ).toBe("host-a.c.proj-1.internal");
  });

  it("uses internal http routing for tunneled GCP project hosts", () => {
    expect(
      resolveGcpManagedHostInternalUrl({
        runtime: {
          provider: "gcp",
          instance_id: "host-a",
          ssh_user: "ubuntu",
          metadata: { gcp_project_id: "proj-1" },
        },
        tunnelEnabled: true,
      }),
    ).toBe("http://host-a.c.proj-1.internal:9002");
  });

  it("rewrites public conat addresses to internal bay router addresses", () => {
    expect(
      resolveGcpInternalConatUrl({
        currentAddress: "https://alpha.cocalc.ai",
        bayInternalHostname: "alpha.c.projecthosts.internal",
      }),
    ).toBe("http://alpha.c.projecthosts.internal:9102");
  });
});
