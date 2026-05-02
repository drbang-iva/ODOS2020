import type { ReactElement } from "react";

export interface SmartAppReviewManifest {
  readonly name: string;
  readonly riskClass: string;
  readonly phiBoundary: string;
  readonly launchMode: string;
  readonly networkEgress: string;
  readonly externalServicesRequired: boolean;
  readonly baaRequired: boolean;
  readonly imageAnalysisProhibited: boolean;
  readonly allowedJurisdictions: readonly string[];
  readonly prohibitedStates: readonly string[];
  readonly requiredCapabilities: readonly string[];
}

export function SmartAppReviewPanel(input: {
  readonly manifest: SmartAppReviewManifest;
  readonly supportedCapabilities: readonly string[];
  readonly compatibilityGapAttested: boolean;
  readonly onCompatibilityGapAttested: (value: boolean) => void;
  readonly onInstall: () => void;
  readonly onReject: () => void;
}): ReactElement {
  const gaps = input.manifest.requiredCapabilities.filter(
    (capability) => !input.supportedCapabilities.includes(capability),
  );
  const blocked =
    !input.manifest.imageAnalysisProhibited ||
    (input.manifest.phiBoundary === "patient-payload" && !input.manifest.baaRequired) ||
    (gaps.length > 0 && !input.compatibilityGapAttested);

  return (
    <section className="smart-app-review" aria-label="SMART app review">
      <header>
        <h2>{input.manifest.name}</h2>
        <p>local eyecare SMART app seed catalog</p>
      </header>
      <dl>
        <div>
          <dt>Risk</dt>
          <dd>{input.manifest.riskClass}</dd>
        </div>
        <div>
          <dt>PHI</dt>
          <dd>{input.manifest.phiBoundary}</dd>
        </div>
        <div>
          <dt>Launch</dt>
          <dd>{input.manifest.launchMode}</dd>
        </div>
        <div>
          <dt>Egress</dt>
          <dd>{input.manifest.networkEgress}</dd>
        </div>
        <div>
          <dt>BAA</dt>
          <dd>{input.manifest.baaRequired ? "required" : "not required"}</dd>
        </div>
        <div>
          <dt>Image analysis</dt>
          <dd>{input.manifest.imageAnalysisProhibited ? "prohibited" : "blocked"}</dd>
        </div>
      </dl>
      <div>
        <h3>Jurisdictions</h3>
        <p>{input.manifest.allowedJurisdictions.join(", ") || "none declared"}</p>
        <p>{input.manifest.prohibitedStates.join(", ") || "no prohibited states"}</p>
      </div>
      <div>
        <h3>Capabilities</h3>
        <p>{input.manifest.requiredCapabilities.join(", ") || "none declared"}</p>
        {gaps.length ? (
          <label>
            <input
              type="checkbox"
              checked={input.compatibilityGapAttested}
              onChange={(event) => input.onCompatibilityGapAttested(event.currentTarget.checked)}
            />
            Compatibility gap reviewed: {gaps.join(", ")}
          </label>
        ) : null}
      </div>
      <footer>
        <button type="button" onClick={input.onReject}>
          Reject
        </button>
        <button type="button" onClick={input.onInstall} disabled={blocked}>
          Install
        </button>
      </footer>
    </section>
  );
}
