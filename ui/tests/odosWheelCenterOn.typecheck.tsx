import { OdosWheel } from "../src/components/inputs/OdosWheel";

// @ts-expect-error centerOn is intentionally omitted to prove it remains required.
const missingCenter = <OdosWheel value={0} min={-1} max={1} step={0.25} format={String} onChange={() => undefined} ariaLabel="Power" />;

void missingCenter;
