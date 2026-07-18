export type VCodeEye = "OD" | "OS";

export interface VCodeRxEye {
  sphere?: number;
  cylinder?: number;
}

export interface VCodeOrderRx {
  od?: VCodeRxEye;
  os?: VCodeRxEye;
}

export interface ResolvedVCode {
  eye: VCodeEye;
  code: string;
  display: string;
  lateralityModifier: "RT" | "LT";
  kind: "base" | "progressive-add-on";
}

export type VCodeResolution =
  | { status: "not-required"; codes: []; reason: string }
  | { status: "unverified"; codes: []; reason: string }
  | { status: "resolved"; codes: ResolvedVCode[] };

type PowerFamily = "V21" | "V22" | "V23";

const POWER_FAMILY_LABELS: Record<PowerFamily, string> = {
  V21: "Single-vision lens",
  V22: "Bifocal lens",
  V23: "Trifocal lens",
};

/**
 * HCPCS lens power bands and descriptions were verified against both sources on 2026-07-18:
 * - CMS July 2026 Alpha-Numeric HCPCS file (updated 2026-06-17):
 *   https://www.cms.gov/files/zip/july-2026-alpha-numeric-hcpcs-file.zip
 * - Wisconsin ForwardHealth, Lenses Available Under the State Purchase Eyeglass Contract:
 *   https://www.forwardhealth.wi.gov/WIPortal/Subsystem/KW/Print.aspx?c=402&ia=1&nt=Lenses+Available+Under+the+State+Purchase+Eyeglass+Contract&p=1&s=2&sa=64
 * CMS also classifies V2781 as a per-lens progressive add-on billed with the appropriate
 * bifocal or trifocal base code (accessed 2026-07-18):
 * https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleid=52499
 */
export function resolveVCode(
  familyHint: string | undefined,
  rx: VCodeOrderRx,
  claimBound: boolean,
): VCodeResolution {
  if (!claimBound) {
    return { status: "not-required", codes: [], reason: "Cash-pay order — HCPCS resolution is not required." };
  }
  const parsed = parseFamilyHint(familyHint);
  if (parsed.status === "unverified") return parsed;

  const eyes: Array<[VCodeEye, VCodeRxEye | undefined]> = [["OD", rx.od], ["OS", rx.os]];
  const presentEyes = eyes.filter((entry): entry is [VCodeEye, VCodeRxEye] => entry[1] !== undefined);
  if (presentEyes.length === 0) {
    return unverified("UNVERIFIED: an order Rx is required before resolving an HCPCS lens code.");
  }

  const codes: ResolvedVCode[] = [];
  for (const [eye, eyeRx] of presentEyes) {
    if (parsed.powerFamily) {
      const powerCode = resolvePowerCode(parsed.powerFamily, eyeRx);
      if (typeof powerCode !== "string") return powerCode;
      if (parsed.exactBaseCode && parsed.exactBaseCode !== powerCode) {
        return unverified(
          `UNVERIFIED: ${parsed.exactBaseCode} does not match the verified ${powerCode} power band for ${eye}.`,
        );
      }
      codes.push({
        eye,
        code: powerCode,
        display: `${POWER_FAMILY_LABELS[parsed.powerFamily]} — verified power band`,
        lateralityModifier: eye === "OD" ? "RT" : "LT",
        kind: "base",
      });
    }
    if (parsed.progressive) {
      codes.push({
        eye,
        code: "V2781",
        display: "Progressive lens, per lens",
        lateralityModifier: eye === "OD" ? "RT" : "LT",
        kind: "progressive-add-on",
      });
    }
  }
  return { status: "resolved", codes };
}

function parseFamilyHint(familyHint: string | undefined):
  | { status: "parsed"; powerFamily?: PowerFamily; progressive: boolean; exactBaseCode?: string }
  | Extract<VCodeResolution, { status: "unverified" }> {
  const normalized = familyHint?.trim().toUpperCase().replace(/XX/g, "");
  if (!normalized) return unverified("UNVERIFIED: this catalog row has no default billing-code family.");

  const parts = normalized.split("+").map((part) => part.trim()).filter(Boolean);
  let powerFamily: PowerFamily | undefined;
  let progressive = false;
  let exactBaseCode: string | undefined;
  for (const part of parts) {
    if (part === "V2781") {
      progressive = true;
      continue;
    }
    if (part === "V21" || part === "V22" || part === "V23") {
      if (powerFamily && powerFamily !== part) return unverified(`UNVERIFIED: conflicting HCPCS families in ${familyHint}.`);
      powerFamily = part;
      continue;
    }
    if (/^V2[123]\d{2}$/.test(part)) {
      const family = part.slice(0, 3) as PowerFamily;
      if (powerFamily && powerFamily !== family) return unverified(`UNVERIFIED: conflicting HCPCS families in ${familyHint}.`);
      powerFamily = family;
      exactBaseCode = part;
      continue;
    }
    return unverified(`UNVERIFIED: unsupported HCPCS lens family "${familyHint}".`);
  }
  if (!powerFamily && !progressive) return unverified(`UNVERIFIED: unsupported HCPCS lens family "${familyHint}".`);
  return { status: "parsed", powerFamily, progressive, exactBaseCode };
}

function resolvePowerCode(
  family: PowerFamily,
  rx: VCodeRxEye,
): string | Extract<VCodeResolution, { status: "unverified" }> {
  if (rx.sphere === undefined || !Number.isFinite(rx.sphere)) {
    return unverified("UNVERIFIED: sphere is required for HCPCS lens power-band resolution.");
  }
  if (rx.cylinder !== undefined && !Number.isFinite(rx.cylinder)) {
    return unverified("UNVERIFIED: cylinder must be a finite number for HCPCS lens power-band resolution.");
  }

  const sphere = Math.abs(rx.sphere);
  const cylinder = Math.abs(rx.cylinder ?? 0);
  if (cylinder === 0) {
    if (sphere <= 4) return `${family}00`;
    if (sphere >= 4.12 && sphere <= 7) return `${family}01`;
    if (sphere >= 7.12 && sphere <= 20) return `${family}02`;
    return bandGap(sphere, cylinder);
  }

  if (sphere <= 4) {
    const cylinderBand = boundedCylinderBand(cylinder, family === "V23" ? 2.25 : 2.12, 2, 4, 6);
    return typeof cylinderBand === "number" ? `${family}${String(3 + cylinderBand).padStart(2, "0")}` : cylinderBand;
  }
  if (sphere >= 4.25 && sphere <= 7) {
    const cylinderBand = boundedCylinderBand(cylinder, 2.12, 2, 4, 6);
    return typeof cylinderBand === "number" ? `${family}${String(7 + cylinderBand).padStart(2, "0")}` : cylinderBand;
  }
  if (sphere >= 7.25 && sphere <= 12) {
    if (cylinder >= 0.25 && cylinder < 2.25) return `${family}11`;
    if (cylinder === 2.25) {
      return unverified(
        `UNVERIFIED: the published ${family}11 and ${family}12 descriptions both include cylinder 2.25 for this sphere band.`,
      );
    }
    if (cylinder > 2.25 && cylinder <= 4) return `${family}12`;
    if (cylinder >= 4.25 && cylinder <= 6) return `${family}13`;
    return bandGap(sphere, cylinder);
  }
  if (sphere > 12) return `${family}14`;
  return bandGap(sphere, cylinder);
}

function boundedCylinderBand(
  cylinder: number,
  secondMin: number,
  firstMax: number,
  secondMax: number,
  thirdMax: number,
): number | Extract<VCodeResolution, { status: "unverified" }> {
  if (cylinder >= 0.12 && cylinder <= firstMax) return 0;
  if (cylinder >= secondMin && cylinder <= secondMax) return 1;
  if (cylinder >= 4.25 && cylinder <= thirdMax) return 2;
  if (cylinder > thirdMax) return 3;
  return bandGap(0, cylinder);
}

function bandGap(sphere: number, cylinder: number): Extract<VCodeResolution, { status: "unverified" }> {
  return unverified(
    `UNVERIFIED: sphere ${sphere.toFixed(2)} / cylinder ${cylinder.toFixed(2)} falls outside the explicitly verified HCPCS power bands.`,
  );
}

function unverified(reason: string): Extract<VCodeResolution, { status: "unverified" }> {
  return { status: "unverified", codes: [], reason };
}
