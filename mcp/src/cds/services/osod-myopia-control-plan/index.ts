import {
  codedPrefetchResources,
  matchingServiceRequests,
  ruleCard,
  snomed,
} from "../common.js";
import type { CdsHookEvaluationInput, CdsHookService } from "../../types.js";

export const MYOPIA_CONTROL_CODES = [
  snomed("57190000", "Myopia"),
] as const;

export const osodMyopiaControlPlanService: CdsHookService = {
  discovery: {
    id: "osod-myopia-control-plan",
    hook: "order-sign",
    title: "OSOD myopia control plan",
    description: "Prompts clinician review of myopia-control plan elements before signing related orders.",
    prefetch: {
      serviceRequests: "ServiceRequest?patient={{context.patientId}}&encounter={{context.encounterId}}",
    },
    usageRequirements: "Local deterministic OSOD specialty rule. No predictive model. No external network call.",
  },
  supportedCodes: MYOPIA_CONTROL_CODES,
  matches(input: CdsHookEvaluationInput): boolean {
    if (input.hook !== "order-sign") {
      return false;
    }
    const requests = codedPrefetchResources(input);
    return matchingServiceRequests(requests, MYOPIA_CONTROL_CODES).length > 0;
  },
  invoke(input: CdsHookEvaluationInput) {
    const matched = matchingServiceRequests(codedPrefetchResources(input), MYOPIA_CONTROL_CODES);
    return {
      cards: [
        ruleCard({
          now: input.now,
          summary: "Review myopia-control plan before signing",
          detail:
            `Matched ${matched.length || 1} myopia-related ServiceRequest. Confirm risk factors, chosen intervention, baseline measurements, follow-up cadence, and family counseling documentation before signing.`,
          evidence:
            "SNOMED CT 57190000 verified 2026-05-02; CDS Hooks 2.0.1 card schema + HTI-1 DSI disclosure fields verified 2026-05-02.",
          suggestions: [
            {
              uuid: "osod-myopia-control-plan-review",
              label: "Document myopia-control plan review",
              actions: [],
            },
          ],
        }),
      ],
    };
  },
};
