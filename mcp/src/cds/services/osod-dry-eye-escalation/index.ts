import {
  codedObservationPrefetchResources,
  observationMatchesAnyCode,
  ruleCard,
  snomed,
} from "../common.js";
import type { CdsHookEvaluationInput, CdsHookService } from "../../types.js";

export const DRY_EYE_CODES = [
  snomed("302896008", "Keratoconjunctivitis sicca"),
] as const;

export const osodDryEyeEscalationService: CdsHookService = {
  discovery: {
    id: "osod-dry-eye-escalation",
    hook: "encounter-discharge",
    title: "OSOD dry eye escalation",
    description: "Checks dry-eye assessment findings before encounter discharge.",
    prefetch: {
      dryEyeAssessments: "Observation?patient={{context.patientId}}&encounter={{context.encounterId}}",
    },
    usageRequirements: "Local deterministic OSOD specialty rule. No image analysis. No external network call.",
  },
  supportedCodes: DRY_EYE_CODES,
  matches(input: CdsHookEvaluationInput): boolean {
    if (input.hook !== "encounter-discharge") {
      return false;
    }
    return observationMatchesAnyCode(codedObservationPrefetchResources(input), DRY_EYE_CODES);
  },
  invoke(input: CdsHookEvaluationInput) {
    return {
      cards: [
        ruleCard({
          now: input.now,
          summary: "Review dry-eye escalation before discharge",
          detail:
            "Dry-eye assessment coding was present in this encounter. Confirm severity, treatment plan, follow-up interval, and whether escalation or co-management is appropriate before discharge.",
          evidence:
            "SNOMED CT 302896008 verified 2026-05-02; CDS Hooks 2.0.1 card schema + HTI-1 DSI disclosure fields verified 2026-05-02.",
          suggestions: [
            {
              uuid: "osod-dry-eye-escalation-review",
              label: "Document dry-eye plan review",
              actions: [],
            },
          ],
        }),
      ],
    };
  },
};
