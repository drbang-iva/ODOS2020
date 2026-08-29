import { OdosWheel, type OdosWheelProps } from "../src/components/inputs/OdosWheel";

// @ts-expect-error centerOn is intentionally omitted to prove it remains required.
const missingCenter = <OdosWheel value={0} min={-1} max={1} step={0.25} format={String} onChange={() => undefined} ariaLabel="Power" />;

const blankValue: OdosWheelProps["value"] = null;
declare const maybeBlankValue: OdosWheelProps["value"];
// @ts-expect-error nullable wheel values must be narrowed before numeric use.
const numericOnlyValue: number = maybeBlankValue;

void missingCenter;
void blankValue;
void numericOnlyValue;
