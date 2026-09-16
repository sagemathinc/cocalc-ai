import { SDK } from "@nebius/js-sdk";
import {
  DiskService,
  ImageService,
  InstanceService,
  PlatformService,
} from "@nebius/js-sdk/api/nebius/compute/v1/index";
import {
  AllocationService,
  SecurityGroupService,
  SecurityRuleService,
  SubnetService,
} from "@nebius/js-sdk/api/nebius/vpc/v1/index";
import { ResourceAdviceService } from "@nebius/js-sdk/api/nebius/capacity/v1/index";
import { ProjectService } from "@nebius/js-sdk/api/nebius/iam/v2/index";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("cloud:nebius:client");

let nebiusUnhandledRejectionInstalled = false;

function isNebiusAuthError(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false;
  const message = reason.message ?? "";
  const stack = reason.stack ?? "";
  return (
    message.includes("DECODER routines::unsupported") ||
    stack.includes("@nebius/js-sdk") ||
    stack.includes("ServiceAccount.getExchangeTokenRequest")
  );
}

function installNebiusUnhandledRejectionHandler() {
  if (nebiusUnhandledRejectionInstalled) return;
  nebiusUnhandledRejectionInstalled = true;
  process.on("unhandledRejection", (reason) => {
    if (isNebiusAuthError(reason)) {
      // Nebius SDK can reject from a background token renewal; log and keep
      // running so a bad key doesn't take the whole hub down.
      logger.warn("nebius auth failure (ignored)", { err: reason });
      return;
    }
    throw reason;
  });
}
export type NebiusCreds = {
  serviceAccountId: string;
  publicKeyId: string;
  privateKeyPem: string;
  parentId: string;
};

export class NebiusClient {
  private sdk: SDK;
  private closing?: Promise<void>;
  readonly disks: DiskService;
  readonly instances: InstanceService;
  readonly images: ImageService;
  readonly platforms: PlatformService;
  readonly allocations: AllocationService;
  readonly securityGroups: SecurityGroupService;
  readonly securityRules: SecurityRuleService;
  readonly subnets: SubnetService;
  readonly resourceAdvice: ResourceAdviceService;
  readonly projects: ProjectService;

  constructor(creds: NebiusCreds) {
    installNebiusUnhandledRejectionHandler();
    this.sdk = new SDK({
      credentials: {
        serviceAccountId: creds.serviceAccountId,
        publicKeyId: creds.publicKeyId,
        privateKeyPem: creds.privateKeyPem,
      },
      parentId: creds.parentId,
    });
    this.disks = new DiskService(this.sdk);
    this.instances = new InstanceService(this.sdk);
    this.images = new ImageService(this.sdk);
    this.platforms = new PlatformService(this.sdk);
    this.allocations = new AllocationService(this.sdk);
    this.securityGroups = new SecurityGroupService(this.sdk);
    this.securityRules = new SecurityRuleService(this.sdk);
    this.subnets = new SubnetService(this.sdk);
    this.resourceAdvice = new ResourceAdviceService(this.sdk);
    this.projects = new ProjectService(this.sdk);
  }

  parentId(): string | undefined {
    return this.sdk.parentId();
  }

  close(): Promise<void> {
    // Service-account renewal timers retain the SDK and its native TLS contexts
    // even after the last request. GC alone cannot release these resources.
    return (this.closing ??= this.sdk.close());
  }

  async [Symbol.asyncDispose](): Promise<void> {
    try {
      await this.close();
    } catch (err) {
      // A cleanup failure must not turn a successful cloud mutation into a
      // failed operation that callers might retry, or mask its original error.
      logger.warn("failed to close Nebius SDK", { err });
    }
  }
}
