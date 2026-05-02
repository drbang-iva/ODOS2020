import { osodContactLensFinalizeService } from "./osod-contact-lens-finalize/index.js";
import { osodDryEyeEscalationService } from "./osod-dry-eye-escalation/index.js";
import { osodMyopiaControlPlanService } from "./osod-myopia-control-plan/index.js";
import type { CdsHookService } from "../types.js";

export const OSOD_DEFAULT_CDS_SERVICES: readonly CdsHookService[] = [
  osodContactLensFinalizeService,
  osodMyopiaControlPlanService,
  osodDryEyeEscalationService,
] as const;

export const OSOD_DEFAULT_CDS_SERVICE_IDS = OSOD_DEFAULT_CDS_SERVICES.map(
  (service) => service.discovery.id,
);
