export type OrbitalId =
  | "anterior-segment"
  | "refractive"
  | "systemic"
  | "posterior-segment"
  | "retina"
  | "lids-adnexa";

export const ORBITAL_LABELS: Record<OrbitalId, string> = {
  "anterior-segment": "Anterior Segment",
  "refractive": "Refractive",
  "systemic": "Systemic",
  "posterior-segment": "Posterior Segment",
  "retina": "Retina",
  "lids-adnexa": "Lids / Adnexa",
};

/**
 * Mapping from orbital ID to HL7 Eyecare IG anatomical-location codes.
 * v0.1 POC should tag Observations with these codes; OrbitalDetail uses
 * the mapping in reverse to filter Observations by orbital.
 *
 * These codes are placeholders from SNOMED CT. When the v0.1 FHIR profiles
 * are authored via FSH/SUSHI against the HL7 Eyecare IG, swap these for the
 * IG-sanctioned ValueSet members.
 */
export const ORBITAL_LOCATION_CODES: Record<OrbitalId, string[]> = {
  "anterior-segment": ["363817007", "32323000"],   // Cornea, Anterior chamber
  "refractive": ["82929001"],                       // Refractive state
  "systemic": [],                                   // Whole body / no specific eye region
  "posterior-segment": ["63572009", "5665001"],    // Optic nerve, Vitreous body
  "retina": ["5665001", "47621009"],                // Retina, Macula
  "lids-adnexa": ["80243003", "91878002"],          // Eyelid, Eyelash
};
