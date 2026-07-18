import type { VisionPrescription } from "@medplum/fhirtypes";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { fhir } from "../lib/fhir";
import {
  LENS_DESIGN_TYPES,
  coatingOptionAdapter,
  lensProductAdapter,
  modifierOptionAdapter,
  suggestedRetailPerPairCents,
  type CoatingOption,
  type LensDesignType,
  type LensProduct,
  type ModifierOption,
} from "../lib/lens-catalog";
import {
  checkStockMatch,
  fuzzySearchLensProducts,
  lensOrderRxFromVisionPrescription,
  lensProductEnvelopeCheck,
  modifierLinesForSelection,
  resolveLensSelectionBilling,
  type AttachedLensSelection,
  type LensFulfillment,
  type LensModifierLine,
  type LensSelection,
} from "../lib/lens-selection";

interface LensesOrderSurfaceProps {
  open: boolean;
  rx: VisionPrescription | null;
  initialSelection?: AttachedLensSelection;
  claimBound?: boolean;
  products?: readonly LensProduct[];
  coatings?: readonly CoatingOption[];
  modifiers?: readonly ModifierOption[];
  onCancel: () => void;
  onCommit: (selection: LensSelection) => void;
}

export function LensesOrderSurface({
  open,
  rx,
  initialSelection,
  claimBound = false,
  products: suppliedProducts,
  coatings: suppliedCoatings,
  modifiers: suppliedModifiers,
  onCancel,
  onCommit,
}: LensesOrderSurfaceProps) {
  const [products, setProducts] = useState<LensProduct[]>([]);
  const [coatings, setCoatings] = useState<CoatingOption[]>([]);
  const [modifiers, setModifiers] = useState<ModifierOption[]>([]);
  const [selectedLab, setSelectedLab] = useState("bp-digital");
  const [designType, setDesignType] = useState<LensDesignType | undefined>();
  const [designName, setDesignName] = useState("");
  const [materialKey, setMaterialKey] = useState("");
  const [productId, setProductId] = useState("");
  const [coatingId, setCoatingId] = useState("");
  const [confirmedModifiers, setConfirmedModifiers] = useState<Record<string, boolean>>({});
  const [fulfillment, setFulfillment] = useState<LensFulfillment>("lab");
  const [query, setQuery] = useState("");
  const [clickCount, setClickCount] = useState(0);
  const [loadError, setLoadError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const rxContext = useMemo(() => lensOrderRxFromVisionPrescription(rx), [rx]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>(focusableSelector())?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      const returnTarget = returnFocusRef.current;
      returnFocusRef.current = null;
      returnTarget?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setClickCount(0);
    setQuery("");
    setLoadError("");
    let cancelled = false;
    const load = suppliedProducts && suppliedCoatings && suppliedModifiers
      ? Promise.resolve([suppliedProducts, suppliedCoatings, suppliedModifiers] as const)
      : Promise.all([
          lensProductAdapter(fhir).list(),
          coatingOptionAdapter(fhir).list(),
          modifierOptionAdapter(fhir).list(),
        ]);
    load.then(([nextProducts, nextCoatings, nextModifiers]) => {
      if (cancelled) return;
      setProducts(nextProducts.filter((product) => product.active).map((product) => structuredClone(product)));
      setCoatings(nextCoatings.filter((coating) => coating.active).map((coating) => structuredClone(coating)));
      setModifiers(nextModifiers.filter((modifier) => modifier.active).map((modifier) => structuredClone(modifier)));
      const prior = initialSelection && nextProducts.find((product) => product.id === initialSelection.productId);
      if (prior) {
        setSelectedLab(prior.lab);
        setDesignType(prior.design.type);
        setDesignName(prior.design.productName);
        setMaterialKey(prior.material.key);
        setProductId(prior.id);
        setCoatingId(initialSelection.coating?.id ?? "");
        const selectedModifierIds = new Set(initialSelection.modifiers.map((modifier) => modifier.id));
        setConfirmedModifiers(Object.fromEntries(
          modifierLinesForSelection(nextModifiers, prior.lab, rxContext)
            .map((modifier) => [modifier.id, selectedModifierIds.has(modifier.id)]),
        ));
        setFulfillment(initialSelection.fulfillment);
      } else {
        setSelectedLab("bp-digital");
        setDesignType(undefined);
        setDesignName("");
        setMaterialKey("");
        setProductId("");
        setCoatingId(houseDefault(nextCoatings, "bp-digital")?.id ?? "");
        setConfirmedModifiers({});
        setFulfillment("lab");
      }
    }).catch((cause) => {
      if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [open, initialSelection, suppliedProducts, suppliedCoatings, suppliedModifiers, rxContext]);

  const validProducts = useMemo(
    () => products.filter((product) => lensProductEnvelopeCheck(product, rxContext).fits),
    [products, rxContext],
  );
  const concreteLab = selectedLab === "all" ? undefined : selectedLab;
  const selectedProduct = products.find((product) => product.id === productId);
  const activeSelectedCoating = coatings.find((coating) => coating.id === coatingId);
  const retainedCoating = !activeSelectedCoating
    && initialSelection
    && selectedProduct?.id === initialSelection.productId
    && coatingId === initialSelection.coating?.id
      ? {
          id: initialSelection.coating.id,
          active: false,
          lab: initialSelection.lab,
          category: initialSelection.coating.category,
          name: initialSelection.coating.name,
          pricePerPairCents: initialSelection.coating.sourcePriceCents,
        } satisfies CoatingOption
      : undefined;
  const selectedCoating = activeSelectedCoating ?? retainedCoating;
  const labOptions = unique(products.map((product) => product.lab));
  const typeProducts = validProducts.filter((product) =>
    product.design.type === designType && (!concreteLab || product.lab === concreteLab),
  );
  const designOptions = uniqueBy(
    typeProducts,
    (product) => `${product.lab}|${product.design.productName}`,
  ).map((product) => ({
    lab: product.lab,
    name: product.design.productName,
    minFitHeight: product.design.minFitHeight,
    fromCents: Math.min(...typeProducts
      .filter((candidate) => candidate.lab === product.lab && candidate.design.productName === product.design.productName)
      .map((candidate) => candidate.retailPerPairCents)),
  })).sort((a, b) => a.fromCents - b.fromCents);
  const materialOptions = uniqueBy(
    validProducts.filter((product) =>
      product.lab === concreteLab && product.design.productName === designName && product.design.type === designType,
    ),
    (product) => product.material.key,
  ).map((product) => product.material);
  const treatmentOptions = validProducts.filter((product) =>
    product.lab === concreteLab
    && product.design.productName === designName
    && product.design.type === designType
    && product.material.key === materialKey,
  );
  const coatingOptions = coatings.filter((coating) => coating.lab === concreteLab);
  const rawModifierLines = selectedProduct
    ? modifierLinesForSelection(modifiers, selectedProduct.lab, rxContext)
    : [];
  const activeCatalogModifierIds = new Set(
    modifiers
      .filter((modifier) => modifier.active && modifier.lab === selectedProduct?.lab)
      .map((modifier) => modifier.id),
  );
  const retainedModifierLines: LensModifierLine[] = initialSelection && selectedProduct?.id === initialSelection.productId
    ? initialSelection.modifiers
        .filter((modifier) => !activeCatalogModifierIds.has(modifier.id))
        .map((modifier) => ({
          ...modifier,
          lab: initialSelection.lab,
          confirmed: true,
          retained: true,
        }))
    : [];
  const modifierLines = [...rawModifierLines.map((line) => ({
    ...line,
    confirmed: confirmedModifiers[line.id] ?? true,
  })), ...retainedModifierLines];
  const billing = resolveLensSelectionBilling(
    selectedProduct?.defaultBillingCodeFamily,
    { od: rxContext.od, os: rxContext.os },
    claimBound,
  );
  const envelope = selectedProduct ? lensProductEnvelopeCheck(selectedProduct, rxContext) : undefined;
  const coatingRetailCents = selectedCoating ? addOnRetailCents(selectedCoating.pricePerPairCents) : 0;
  const totalCents = (selectedProduct?.retailPerPairCents ?? 0) + coatingRetailCents
    + modifierLines.filter((line) => line.confirmed).reduce((sum, line) => sum + line.chargeCents, 0);
  const searchProducts = products.filter((product) => selectedLab === "all" || product.lab === selectedLab);
  const searchResults = query.trim().length >= 2
    ? fuzzySearchLensProducts(query, searchProducts, rxContext)
    : [];
  const stockMatch = checkStockMatch();
  const canCommit = Boolean(
    selectedProduct
    && envelope?.fits
    && (!claimBound || billing.status === "resolved"),
  );

  if (!open) return null;

  function count(action: () => void) {
    setClickCount((value) => value + 1);
    action();
  }

  function chooseLab(lab: string) {
    count(() => {
      setSelectedLab(lab);
      setDesignName("");
      setMaterialKey("");
      setProductId("");
      setCoatingId(lab === "all" ? "" : houseDefault(coatings, lab)?.id ?? "");
      setConfirmedModifiers({});
    });
  }

  function chooseDesign(lab: string, name: string) {
    count(() => {
      setSelectedLab(lab);
      setDesignName(name);
      setMaterialKey("");
      setProductId("");
      setCoatingId(houseDefault(coatings, lab)?.id ?? "");
      setConfirmedModifiers({});
    });
  }

  function chooseProduct(product: LensProduct, fromSearch = false) {
    count(() => {
      setSelectedLab(product.lab);
      setDesignType(product.design.type);
      setDesignName(product.design.productName);
      setMaterialKey(product.material.key);
      setProductId(product.id);
      setCoatingId(houseDefault(coatings, product.lab)?.id ?? "");
      setConfirmedModifiers({});
      if (fromSearch) setQuery("");
    });
  }

  function commit() {
    if (!selectedProduct || !canCommit) return;
    onCommit({
      product: structuredClone(selectedProduct),
      ...(selectedCoating ? { coating: structuredClone(selectedCoating) } : {}),
      modifiers: modifierLines.map((line) => ({ ...line })),
      fulfillment,
      billing,
    });
  }

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector()) ?? [])];
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="lenses-surface-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="lenses-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lenses-title"
        onKeyDown={handleDialogKeyDown}
      >
        <header className="lenses-surface-header">
          <div>
            <span>Optical order</span>
            <h2 id="lenses-title">Lenses</h2>
            <p>Choose in lab language. The attached Rx quietly removes combinations that cannot hold both eyes.</p>
          </div>
          <button type="button" onClick={onCancel} aria-label="Close Lenses">×</button>
        </header>

        <div className="lenses-context">
          <span className={rxContext.od || rxContext.os ? "is-checked" : "is-unchecked"}>
            {rxContext.od || rxContext.os ? "Rx in context" : "Rx not checked"}
          </span>
          <label>
            <span>Search this {selectedLab === "all" ? "catalog" : "lab"}</span>
            <input
              aria-label="Search lenses"
              value={query}
              placeholder="Try 167 xtractive alpha"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {searchResults.length > 0 ? (
            <div className="lenses-search-results" role="listbox" aria-label="Lens search results">
              {searchResults.map(({ product, envelope: result }) => (
                <button
                  key={product.id}
                  type="button"
                  className={result.fits ? "" : "is-blocked"}
                  disabled={!result.fits}
                  onClick={() => chooseProduct(product, true)}
                >
                  <strong>{product.design.productName} · {product.material.name} {product.material.index} · {treatmentLabel(product)}</strong>
                  <span>{labLabel(product.lab)} · {formatPair(product.retailPerPairCents)}</span>
                  {!result.fits ? <em>Outside Rx envelope — {result.reason}</em> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {loadError ? <div className="lenses-error" role="alert">Lens Catalog unavailable: {loadError}</div> : null}

        <div className="lenses-surface-grid">
          <div className="lenses-flow">
            <FlowRow number="1" label="Design type">
              {LENS_DESIGN_TYPES.map((type) => {
                const available = validProducts.some((product) => product.design.type === type);
                return <Chip
                  key={type}
                  label={designTypeLabel(type)}
                  selected={designType === type}
                  disabled={!available}
                  onClick={() => count(() => {
                    setDesignType(type);
                    setDesignName("");
                    setMaterialKey("");
                    setProductId("");
                    setConfirmedModifiers({});
                  })}
                />;
              })}
            </FlowRow>

            <FlowRow number="2" label="Lab" note="Primary lab pre-set">
              {labOptions.map((lab) => <Chip
                key={lab}
                label={labLabel(lab)}
                tag={lab === "bp-digital" ? "primary" : undefined}
                selected={selectedLab === lab}
                onClick={() => chooseLab(lab)}
              />)}
              <Chip label="All labs" tag="browse the whole range" selected={selectedLab === "all"} onClick={() => chooseLab("all")} />
            </FlowRow>

            <FlowRow number="3" label="Design" note={selectedLab === "all" ? "Price-sorted across lab books" : "This lab's names"}>
              {designType ? designOptions.map((option) => <Chip
                key={`${option.lab}-${option.name}`}
                label={option.name}
                tag={[
                  option.minFitHeight ? `fit ${option.minFitHeight}` : "",
                  selectedLab === "all" ? labLabel(option.lab) : "",
                  selectedLab === "all" ? `from ${formatPair(option.fromCents)}` : "",
                ].filter(Boolean).join(" · ")}
                selected={concreteLab === option.lab && designName === option.name}
                onClick={() => chooseDesign(option.lab, option.name)}
              />) : <RowPrompt text="Choose a design type to see Rx-valid designs." />}
            </FlowRow>

            <FlowRow number="4" label="Material">
              {designName ? materialOptions.map((material) => <Chip
                key={material.key}
                label={material.name}
                tag={`${material.index}${material.includedBaseCoating ? ` · ${material.includedBaseCoating}` : ""}`}
                selected={materialKey === material.key}
                onClick={() => count(() => {
                  setMaterialKey(material.key);
                  setProductId("");
                  setConfirmedModifiers({});
                })}
              />) : <RowPrompt text="Choose a design first." />}
            </FlowRow>

            <FlowRow number="5" label="Treatment + color">
              {materialKey ? treatmentOptions.map((product) => <Chip
                key={product.id}
                label={product.treatment.brand}
                tag={[product.treatment.family, product.treatment.color].filter(Boolean).join(" · ")}
                selected={productId === product.id}
                onClick={() => chooseProduct(product)}
              />) : <RowPrompt text="Choose a material first." />}
            </FlowRow>

            <FlowRow number="6" label="Coatings" note="House default pre-selected">
              {concreteLab ? <>
                <button
                  type="button"
                  className={`lenses-coating${coatingId === "" ? " is-selected" : ""}`}
                  onClick={() => count(() => setCoatingId(""))}
                >
                  <span aria-hidden>{coatingId === "" ? "●" : "○"}</span>
                  <strong>None</strong>
                  <em>{formatPair(0)}</em>
                </button>
                {retainedCoating ? <button
                  type="button"
                  className="lenses-coating is-selected"
                  disabled
                >
                  <span aria-hidden>●</span>
                  <strong>{retainedCoating.name}<small>retained · no longer active</small></strong>
                  <em>{formatPair(addOnRetailCents(retainedCoating.pricePerPairCents))}</em>
                </button> : null}
                {coatingOptions.map((coating) => (
                <button
                  key={coating.id}
                  type="button"
                  className={`lenses-coating${coatingId === coating.id ? " is-selected" : ""}`}
                  onClick={() => count(() => setCoatingId(coating.id))}
                >
                  <span aria-hidden>{coatingId === coating.id ? "●" : "○"}</span>
                  <strong>{coating.name}{coating.isHouseDefault ? <small>house default</small> : null}</strong>
                  <em>{formatPair(addOnRetailCents(coating.pricePerPairCents))}</em>
                </button>
                ))}
              </> : <RowPrompt text="Choose a design to return to its lab coating menu." />}
            </FlowRow>
          </div>

          <aside className="lenses-summary" aria-label="Lens selection summary">
            <div className={`lenses-envelope ${envelope?.fits ? "is-good" : envelope?.checked ? "is-bad" : ""}`}>
              {envelope ? `${envelope.fits ? "✓" : "×"} ${envelope.reason}` : rxContext.od || rxContext.os ? "Complete the rows to check the Rx envelope." : "Rx not checked — browsing the full book."}
            </div>

            {selectedProduct ? <>
              <SummaryLine label={`${selectedProduct.design.productName} · ${selectedProduct.material.name} ${selectedProduct.material.index} · ${treatmentLabel(selectedProduct)}`} cents={selectedProduct.retailPerPairCents} />
              {selectedCoating ? <SummaryLine label={selectedCoating.name} cents={coatingRetailCents} /> : null}
              {modifierLines.map((line) => <ModifierSummaryLine
                key={line.id}
                line={line}
                onChange={(confirmed) => setConfirmedModifiers((current) => ({ ...current, [line.id]: confirmed }))}
              />)}
              <div className="lenses-total"><span>Lenses total</span><strong>{formatPair(totalCents)}</strong></div>
            </> : <p className="lenses-summary-empty">The live selection, price, billing status, and fulfillment choice will build here.</p>}

            <div className={`lenses-billing is-${billing.status}`}>
              <strong>Billing</strong>
              {billing.status === "resolved"
                ? <div>{billing.codes.map((code) => <span key={`${code.eye}-${code.code}-${code.kind}`}>{code.code} · {code.eye}</span>)}</div>
                : <p>{billing.reason}</p>}
            </div>

            <fieldset className="lenses-fulfillment">
              <legend>Fulfillment</legend>
              <label><input type="radio" name="lens-fulfillment" checked={fulfillment === "lab"} onChange={() => setFulfillment("lab")} /> Send to lab {selectedProduct ? labLabel(selectedProduct.lab) : ""}</label>
              <label className="is-disabled"><input type="radio" name="lens-fulfillment" disabled checked={fulfillment === "in-house"} onChange={() => setFulfillment("in-house")} /> In-house — edge from stock <small>{stockMatch ? "match" : "Build B · not yet wired"}</small></label>
            </fieldset>

            <button className="lenses-add" type="button" disabled={!canCommit} onClick={commit}>Add to order</button>
            <div className="lenses-click-count">Selection clicks: <b>{clickCount}</b> · primary-lab target ≤4</div>
          </aside>
        </div>
      </section>
    </div>
  );
}

export function AttachedLensPanel({
  lens,
  disabled = false,
  onChange,
  onUnattach,
}: {
  lens: AttachedLensSelection;
  disabled?: boolean;
  onChange: () => void;
  onUnattach: () => void;
}) {
  return (
    <section className="attached-lens-panel" aria-label="Attached lens selection">
      <div><span>Lab</span><strong>{labLabel(lens.lab)}</strong></div>
      <div><span>Design</span><strong>{lens.productName}</strong></div>
      <div><span>Material</span><strong>{lens.material.name} · {lens.material.index}</strong></div>
      <div><span>Treatment</span><strong>{[lens.treatment.brand, lens.treatment.color].filter(Boolean).join(" ")}</strong></div>
      <div><span>Coating</span><strong>{lens.coating?.name ?? "None"}</strong></div>
      <div><span>Fulfillment</span><strong>{lens.fulfillment === "lab" ? `Send to ${labLabel(lens.lab)}` : "In-house"}</strong></div>
      <div className="attached-lens-actions">
        <button type="button" className="sidebar-button" disabled={disabled} onClick={onChange}>Change lenses</button>
        <button type="button" className="sidebar-button" disabled={disabled} onClick={onUnattach}>Unattach lenses</button>
      </div>
    </section>
  );
}

function FlowRow({ number, label, note, children }: { number: string; label: string; note?: string; children: ReactNode }) {
  return <section className="lenses-flow-row"><h3><b>{number}</b>{label}{note ? <small>{note}</small> : null}</h3><div>{children}</div></section>;
}

function Chip({ label, tag, selected = false, disabled = false, onClick }: { label: string; tag?: string; selected?: boolean; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className={`lenses-chip${selected ? " is-selected" : ""}`} disabled={disabled} onClick={onClick}><strong>{label}</strong>{tag ? <span>{tag}</span> : null}</button>;
}

function RowPrompt({ text }: { text: string }) {
  return <p className="lenses-row-prompt">{text}</p>;
}

function SummaryLine({ label, cents }: { label: string; cents: number }) {
  return <div className="lenses-summary-line"><span>{label}</span><strong>{formatPair(cents)}</strong></div>;
}

function ModifierSummaryLine({ line, onChange }: { line: LensModifierLine; onChange: (confirmed: boolean) => void }) {
  return <label className="lenses-summary-line is-modifier"><span><input type="checkbox" checked={line.confirmed} disabled={line.retained} onChange={(event) => onChange(event.target.checked)} />{line.automatic ? <small>auto</small> : null}{line.retained ? <small>retained</small> : null}{line.ruleLabel ?? line.name}</span><strong>{formatPair(line.chargeCents)}</strong></label>;
}

function houseDefault(options: readonly CoatingOption[], lab: string): CoatingOption | undefined {
  return options.find((option) => option.lab === lab && option.active && option.isHouseDefault);
}

function treatmentLabel(product: LensProduct): string {
  return [product.treatment.brand, product.treatment.color].filter(Boolean).join(" ");
}

function formatPair(cents: number): string {
  return `${money(cents)}/pair · ${money(Math.round(cents / 2))}/lens`;
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function addOnRetailCents(sourcePriceCents: number): number {
  return sourcePriceCents === 0 ? 0 : suggestedRetailPerPairCents(sourcePriceCents);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function labLabel(lab: string): string {
  if (lab === "bp-digital") return "BP Digital";
  return lab.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function designTypeLabel(type: LensDesignType): string {
  const labels: Record<LensDesignType, string> = {
    "single-vision": "Single Vision",
    "flat-top-28": "FT-28",
    "flat-top-35": "FT-35",
    "7x28": "7×28",
    "8x35": "8×35",
    round: "Round",
    blended: "Blended",
    "double-segment": "Double Segment",
    aspheric: "Aspheric",
    progressive: "Progressive",
    "office-computer": "Office / Computer",
    "anti-fatigue": "Anti-Fatigue",
    trifocal: "Trifocal",
    lenticular: "Lenticular",
  };
  return labels[type];
}

function focusableSelector(): string {
  return "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex='-1'])";
}
