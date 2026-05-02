import {
  codedPrefetchResources,
  matchingServiceRequests,
  ruleCard,
  snomed,
} from "../common.js";
import type { CdsHookEvaluationInput, CdsHookService } from "../../types.js";

export const CONTACT_LENS_FINALIZATION_CODES = [
  snomed("2488002", "Prescription, fitting and dispensing of contact lens"),
  snomed("6213004", "Prescribing corneoscleral contact lens"),
] as const;

export const osodContactLensFinalizeService: CdsHookService = {
  discovery: {
    id: "osod-contact-lens-finalize",
    hook: "order-sign",
    title: "OSOD contact lens finalize",
    description: "Reviews contact lens fitting and finalization orders before signing.",
    prefetch: {
      serviceRequests: "ServiceRequest?patient={{context.patientId}}&encounter={{context.encounterId}}",
    },
    usageRequirements: "Local deterministic OSOD specialty rule. No image analysis. No external network call.",
  },
  supportedCodes: CONTACT_LENS_FINALIZATION_CODES,
  matches(input: CdsHookEvaluationInput): boolean {
    if (input.hook !== "order-sign") {
      return false;
    }
    const requests = codedPrefetchResources(input);
    return matchingServiceRequests(requests, CONTACT_LENS_FINALIZATION_CODES).length > 0;
  },
  invoke(input: CdsHookEvaluationInput) {
    const matched = matchingServiceRequests(codedPrefetchResources(input), CONTACT_LENS_FINALIZATION_CODES);
    return {
      cards: [
        ruleCard({
          now: input.now,
          summary: "Review contact lens finalization before signing",
          detail:
            `Matched ${matched.length || 1} contact lens fitting/finalization ServiceRequest. Confirm final parameters, lens material, replacement schedule, follow-up timing, and patient handling instructions before signing.`,
          evidence:
            "SNOMED CT 2488002 and 6213004 verified 2026-05-02; CDS Hooks 2.0.1 card schema + HTI-1 DSI disclosure fields verified 2026-05-02.",
          suggestions: [
            {
              uuid: "osod-contact-lens-finalize-review",
              label: "Document final contact lens parameters",
              actions: [],
            },
          ],
        }),
      ],
    };
  },
};
