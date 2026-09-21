import type { ImagingCategory } from "./imaging-endpoint.js";

export type FollowUpResultKind =
  | { kind: "image"; category: ImagingCategory }
  | { kind: "pending"; reason: string }
  | { kind: "none"; reason: string };

export const FOLLOW_UP_RESULT_KINDS: Readonly<Record<string, FollowUpResultKind>> = {
  "anterior-segment-oct|": { kind: "none", reason: "This test cannot be ordered in ODOS yet." },
  "corneal-hysteresis|": { kind: "none", reason: "This test cannot be ordered in ODOS yet." },
  "corneal-pachymetry|": { kind: "pending", reason: "A recorded finding will complete this test in a later slice." },
  "erg|": { kind: "none", reason: "This test cannot be ordered in ODOS yet." },
  "fundus-photography|": { kind: "image", category: "fundus-photo" },
  "fundus-photography|optic nerve": { kind: "image", category: "fundus-photo" },
  "fundus-photography|retina": { kind: "image", category: "fundus-photo" },
  "gonioscopy|": { kind: "pending", reason: "A recorded finding will complete this test in a later slice." },
  "inflammadry-mmp-9|": { kind: "pending", reason: "A recorded finding will complete this test in a later slice." },
  "meibography|": { kind: "pending", reason: "A recorded finding will complete this test in a later slice." },
  "oct-angiography|": { kind: "none", reason: "This test cannot be ordered in ODOS yet." },
  "oct-retina|": { kind: "none", reason: "This test cannot be ordered in ODOS yet." },
  "ocular-surface-staining|": { kind: "pending", reason: "A recorded finding will complete this test in a later slice." },
  "scodi-optic-nerve|": { kind: "image", category: "oct" },
  "tear-osmolarity|": { kind: "pending", reason: "A recorded finding will complete this test in a later slice." },
  "visual-field-threshold|": { kind: "image", category: "visual-field" },
};

export function resultKind(orderable: string, focus?: string): FollowUpResultKind {
  return FOLLOW_UP_RESULT_KINDS[`${orderable}|${focus ?? ""}`]
    ?? FOLLOW_UP_RESULT_KINDS[`${orderable}|`]
    ?? { kind: "none", reason: "No result workflow is available for this test." };
}
