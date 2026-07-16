import { odosContactLensFinalizeService } from "./odos-contact-lens-finalize/index.js";
import { odosDryEyeEscalationService } from "./odos-dry-eye-escalation/index.js";
import { odosMyopiaControlPlanService } from "./odos-myopia-control-plan/index.js";
import type { CdsHookService } from "../types.js";

export const ODOS_DEFAULT_CDS_SERVICES: readonly CdsHookService[] = [
  odosContactLensFinalizeService,
  odosMyopiaControlPlanService,
  odosDryEyeEscalationService,
] as const;

export const ODOS_DEFAULT_CDS_SERVICE_IDS = ODOS_DEFAULT_CDS_SERVICES.map(
  (service) => service.discovery.id,
);
