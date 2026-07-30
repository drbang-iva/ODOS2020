import { Fragment, useEffect, useMemo, useState } from "react";
import {
  canExportFrameCatalogCsv,
  dispenseFrameInventoryUnit,
  dollarsToCentsExact,
  frameInventoryUnitStatusLabel,
  exportableFrameRows,
  loadFramesDataSubscriptionSettings,
  loadPracticeFrameInventoryUnits,
  loadPracticeFrameVariantSettings,
  MAX_RECEIPT_QUANTITY,
  rankFramePosLookupRows,
  receiveFrameInventory,
  saveFramesDataSubscriptionSettings,
  searchFrameCatalog,
  summarizeInventoryByVariant,
  type FrameCatalogItem,
  type FramesDataSubscriptionSettings,
  type PracticeFrameInventorySummary,
  type PracticeFrameInventoryLoad,
  type PracticeFrameInventoryUnit,
  type PracticeFrameVariantSettings,
  type ReceivedFrameInventory,
  type ReceiveFrameInventoryInput,
} from "../lib/optical-frames";
import { fhir } from "../lib/fhir";
import { useRole } from "../lib/role-context";
import { OdosSearchPicker } from "../components/inputs/OdosSearchPicker";

type OpticalFramesRoute = "catalog" | "inventory" | "lookup" | "settings";

export interface OpticalFramesApi {
  searchCatalog(query: string): Promise<FrameCatalogItem[]>;
  loadInventoryUnits(): Promise<PracticeFrameInventoryLoad>;
  loadVariantSettings(): Promise<PracticeFrameVariantSettings[]>;
  receiveInventory(item: FrameCatalogItem, input: ReceiveFrameInventoryInput): Promise<ReceivedFrameInventory>;
  dispenseUnit(unitId: string): Promise<PracticeFrameInventoryUnit>;
}

const defaultApi: OpticalFramesApi = {
  searchCatalog: searchFrameCatalog,
  loadInventoryUnits: loadPracticeFrameInventoryUnits,
  loadVariantSettings: loadPracticeFrameVariantSettings,
  receiveInventory: (item, input) => receiveFrameInventory(item, input, actingPractitionerId()),
  dispenseUnit: (unitId) => dispenseFrameInventoryUnit(unitId, actingPractitionerId()),
};

function actingPractitionerId(): string {
  const actorId = fhir.practitionerId();
  if (!actorId) throw new Error("The signed-in session has no acting Practitioner profile.");
  return actorId;
}

export function OpticalFrames({ route, api = defaultApi }: { route: OpticalFramesRoute; api?: OpticalFramesApi }) {
  const [catalogRows, setCatalogRows] = useState<FrameCatalogItem[]>([]);
  const [units, setUnits] = useState<PracticeFrameInventoryUnit[]>([]);
  const [variantSettings, setVariantSettings] = useState<PracticeFrameVariantSettings[]>([]);
  const [skippedUnitCount, setSkippedUnitCount] = useState(0);
  const [query, setQuery] = useState("");
  const [selectedCatalogItem, setSelectedCatalogItem] = useState<FrameCatalogItem>();
  const [error, setError] = useState<string | null>(null);
  const inventoryRows = useMemo(
    () => summarizeInventoryByVariant(units, variantSettings, catalogRows),
    [catalogRows, units, variantSettings],
  );

  useEffect(() => {
    let cancelled = false;
    api.searchCatalog("")
      .then((catalog) => {
        if (!cancelled) setCatalogRows(catalog);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (route === "settings") return;
    let cancelled = false;
    Promise.all([api.loadInventoryUnits(), api.loadVariantSettings()])
      .then(([inventoryLoad, loadedSettings]) => {
        if (cancelled) return;
        setUnits([...inventoryLoad.units]);
        setSkippedUnitCount(inventoryLoad.skippedCount);
        setVariantSettings(loadedSettings);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [api, route]);

  function inventoryReceived(received: ReceivedFrameInventory) {
    setUnits((current) => [...current, ...received.units]);
    if (received.variantSettings) {
      const updatedSettings = received.variantSettings;
      setVariantSettings((current) => upsertByCanonicalUrl(current, updatedSettings));
    }
  }

  function unitDispensed(updated: PracticeFrameInventoryUnit) {
    setUnits((current) => current.map((unit) => unit.id === updated.id ? updated : unit));
  }

  if (route === "settings") {
    return <FramesDataSettings />;
  }

  return (
    <div className="min-h-screen bg-bg text-[color:var(--odos-text)]">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-6">
        <OpticalNav active={route} />
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-72 flex-1">
            <OdosSearchPicker
              label="Frame catalog"
              value={selectedCatalogItem?.canonicalUrl ?? ""}
              selectedLabel={selectedCatalogItem?.display}
              search={async (searchQuery) => (await api.searchCatalog(searchQuery)).map((item) => ({
                value: item.canonicalUrl,
                label: item.display,
                description: [item.sku, item.gtin14, item.manufacturer].filter(Boolean).join(" · "),
                item,
              }))}
              onClear={() => {
                setSelectedCatalogItem(undefined);
                setQuery("");
                void api.searchCatalog("").then(setCatalogRows).catch((err) => setError(err instanceof Error ? err.message : String(err)));
              }}
              onSelect={(option) => {
                setSelectedCatalogItem(option.item);
                setQuery(option.item.sku);
                setCatalogRows([option.item]);
              }}
            placeholder="SKU, GTIN, brand, model"
            />
          </div>
          {route === "inventory" ? <CsvExportButton rows={catalogRows} /> : null}
        </div>
        {error ? <div role="alert" className="rounded border border-red-500/50 bg-red-950/30 p-3 text-sm text-red-100">{error}</div> : null}
        {skippedUnitCount > 0 ? <MalformedUnitWarning count={skippedUnitCount} /> : null}
        {route === "catalog" ? (
          <CatalogTable
            rows={catalogRows}
            onReceive={api.receiveInventory}
            onReceived={inventoryReceived}
            onError={setError}
          />
        ) : null}
        {route === "inventory" ? (
          <InventoryTable
            rows={inventoryRows}
            units={units}
            catalog={catalogRows}
            onDispense={api.dispenseUnit}
            onDispensed={unitDispensed}
            onError={setError}
          />
        ) : null}
        {route === "lookup" ? <PosLookup rows={catalogRows} inventory={inventoryRows} query={query} /> : null}
      </div>
    </div>
  );
}

function OpticalNav({ active }: { active: OpticalFramesRoute }) {
  const links: Array<[OpticalFramesRoute, string, string]> = [
    ["catalog", "Catalog", "/admin/optical/catalog/frames"],
    ["inventory", "Inventory", "/admin/optical/inventory/frames"],
    ["lookup", "POS lookup", "/dispensary/lookup"],
    ["settings", "Settings", "/admin/practice/settings/frames-data"],
  ];
  return (
    <div className="flex flex-wrap gap-2 border-b border-white/10 pb-3">
      {links.map(([id, label, href]) => (
        <a
          key={id}
          href={href}
          className={`rounded px-3 py-2 text-sm ${active === id ? "bg-brand text-white" : "bg-white/5 text-white/70 hover:bg-white/10"}`}
        >
          {label}
        </a>
      ))}
    </div>
  );
}

function MalformedUnitWarning({ count }: { count: number }) {
  return (
    <div role="alert" className="rounded border border-[color:var(--odos-amber)] bg-[color:var(--odos-surface)] p-3 text-sm text-[color:var(--odos-amber)]">
      Skipped {count} malformed frame inventory {count === 1 ? "unit" : "units"}. Valid inventory remains available.
    </div>
  );
}

export function CatalogTable({
  rows,
  onReceive,
  onReceived,
  onError,
}: {
  rows: readonly FrameCatalogItem[];
  onReceive(item: FrameCatalogItem, input: ReceiveFrameInventoryInput): Promise<ReceivedFrameInventory>;
  onReceived(result: ReceivedFrameInventory): void;
  onError(message: string | null): void;
}) {
  const [receiptRow, setReceiptRow] = useState<FrameCatalogItem>();
  const [quantity, setQuantity] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [cost, setCost] = useState("");
  const [location, setLocation] = useState("");
  const [pending, setPending] = useState(false);
  const [received, setReceived] = useState<{ url: string; quantity: number }>();

  function openReceipt(row: FrameCatalogItem) {
    setReceiptRow(row);
    setQuantity("");
    setSalePrice("");
    setCost("");
    setLocation("");
    setReceived(undefined);
    onError(null);
  }

  async function submitReceipt(event: { preventDefault(): void }) {
    event.preventDefault();
    if (!receiptRow) return;
    setPending(true);
    onError(null);
    try {
      const parsedQuantity = Number(quantity);
      const input: ReceiveFrameInventoryInput = {
        quantity: parsedQuantity,
        ...(salePrice.trim() ? { salePriceCents: dollarsToCentsExact(salePrice) } : {}),
        ...(cost.trim() ? { costCents: dollarsToCentsExact(cost) } : {}),
        ...(location.trim() ? { location: location.trim() } : {}),
      };
      const result = await onReceive(receiptRow, input);
      onReceived(result);
      setReceived({ url: receiptRow.canonicalUrl, quantity: result.units.length });
      setReceiptRow(undefined);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className="overflow-hidden rounded border border-[color:var(--odos-line)]">
        <table className="w-full table-fixed border-collapse text-left text-sm">
          <thead className="bg-white/5 text-white/60">
            <tr>
              <th className="w-1/4 px-3 py-2">Frame</th>
              <th className="w-1/5 px-3 py-2">Identifiers</th>
              <th className="w-1/5 px-3 py-2">Measurements</th>
              <th className="w-1/5 px-3 py-2">Publicity</th>
              <th className="w-28 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.canonicalUrl} className="border-t border-[color:var(--odos-line)]">
                <td className="px-3 py-3">
                  <div className="font-medium">{row.display}</div>
                  <div className="text-xs text-white/50">{row.manufacturer}</div>
                </td>
                <td className="px-3 py-3 text-xs text-white/70">
                  <div>{row.sku}</div>
                  <div>{row.gtin14 ?? ""}</div>
                </td>
                <td className="px-3 py-3 text-xs text-white/70">
                  {[row.properties.eyesize, row.properties.dbl, row.properties.temple].filter(Boolean).join(" / ")}
                </td>
                <td className="px-3 py-3">
                  <span className="rounded bg-white/10 px-2 py-1 text-xs text-white/70">{row.publicityClass}</span>
                </td>
                <td className="px-3 py-3">
                  <button className="sidebar-button w-full" type="button" onClick={() => openReceipt(row)}>
                    {received?.url === row.canonicalUrl ? `Received ${received.quantity} ✓` : "Receipt"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {receiptRow ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-[color:var(--odos-chart-scrim)] p-4 backdrop-blur-sm">
          <form
            aria-label={`Receive ${receiptRow.display}`}
            className="w-full max-w-lg rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-popover)] p-5 shadow-2xl"
            onSubmit={(event) => void submitReceipt(event)}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Receive frames</h2>
                <div className="text-sm text-[color:var(--odos-muted)]">{receiptRow.display} · {receiptRow.sku}</div>
              </div>
              <button className="text-[color:var(--odos-muted)] hover:text-[color:var(--odos-text)]" type="button" onClick={() => setReceiptRow(undefined)}>
                Close
              </button>
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <ReceiptField
                label="Quantity"
                value={quantity}
                type="number"
                required
                min="1"
                max={MAX_RECEIPT_QUANTITY}
                step="1"
                onChange={setQuantity}
              />
              <ReceiptField label="Sale price" value={salePrice} placeholder="179.00" inputMode="decimal" onChange={setSalePrice} />
              <ReceiptField label="Cost" value={cost} placeholder="84.99" inputMode="decimal" onChange={setCost} />
              <ReceiptField label="Location" value={location} placeholder="Optical Front" onChange={setLocation} />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button className="sidebar-button" type="button" disabled={pending} onClick={() => setReceiptRow(undefined)}>
                Cancel
              </button>
              <button className="sidebar-button" type="submit" disabled={pending}>
                {pending ? "Receiving…" : "Receive inventory"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}

function ReceiptField({
  label,
  value,
  type = "text",
  required,
  min,
  max,
  step,
  placeholder,
  inputMode,
  onChange,
}: {
  label: string;
  value: string;
  type?: "text" | "number";
  required?: boolean;
  min?: string;
  max?: number;
  step?: string;
  placeholder?: string;
  inputMode?: "decimal";
  onChange(value: string): void;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-[color:var(--odos-muted)]">{label}{required ? " *" : ""}</span>
      <input
        aria-label={label}
        className="sidebar-input"
        type={type}
        value={value}
        required={required}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        inputMode={inputMode}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function InventoryTable({
  rows,
  units,
  catalog,
  onDispense,
  onDispensed,
  onError,
}: {
  rows: readonly PracticeFrameInventorySummary[];
  units: readonly PracticeFrameInventoryUnit[];
  catalog: readonly FrameCatalogItem[];
  onDispense(unitId: string): Promise<PracticeFrameInventoryUnit>;
  onDispensed(unit: PracticeFrameInventoryUnit): void;
  onError(message: string | null): void;
}) {
  const [expandedUrls, setExpandedUrls] = useState<Set<string>>(() => new Set());
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const catalogByUrl = useMemo(() => new Map(catalog.map((row) => [row.canonicalUrl, row])), [catalog]);
  const unitsByUrl = useMemo(() => {
    const grouped = new Map<string, PracticeFrameInventoryUnit[]>();
    for (const unit of units) {
      const group = grouped.get(unit.canonicalUrl);
      if (group) group.push(unit);
      else grouped.set(unit.canonicalUrl, [unit]);
    }
    return grouped;
  }, [units]);

  function toggle(canonicalUrl: string) {
    setExpandedUrls((current) => {
      const next = new Set(current);
      if (next.has(canonicalUrl)) next.delete(canonicalUrl);
      else next.add(canonicalUrl);
      return next;
    });
  }

  async function markDispensed(unitId: string) {
    setPendingIds((current) => new Set(current).add(unitId));
    onError(null);
    try {
      onDispensed(await onDispense(unitId));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(unitId);
        return next;
      });
    }
  }

  return (
    <div className="overflow-hidden rounded border border-[color:var(--odos-line)]">
      <table className="w-full table-fixed text-left text-sm">
        <thead className="bg-[color:var(--odos-surface-2)] text-[color:var(--odos-muted)]">
          <tr>
            <th className="w-12 px-3 py-2" />
            <th className="px-3 py-2">Frame</th>
            <th className="w-24 px-3 py-2">On Hand</th>
            <th className="w-36 px-3 py-2">Committed</th>
            <th className="w-20 px-3 py-2">Hold</th>
            <th className="w-24 px-3 py-2">Dispensed</th>
            <th className="w-40 px-3 py-2">Location</th>
            <th className="w-32 px-3 py-2">Sale</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const catalogRow = catalogByUrl.get(row.canonicalUrl);
            const expanded = expandedUrls.has(row.canonicalUrl);
            const rowUnits = unitsByUrl.get(row.canonicalUrl) ?? [];
            return (
              <Fragment key={row.canonicalUrl}>
                <tr className="border-t border-[color:var(--odos-line)]">
                  <td className="px-3 py-3">
                    <button
                      aria-expanded={expanded}
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${catalogRow?.display ?? row.canonicalUrl}`}
                      className="rounded px-2 py-1 hover:bg-[color:var(--odos-accent-tint-hi)]"
                      type="button"
                      onClick={() => toggle(row.canonicalUrl)}
                    >
                      {expanded ? "−" : "+"}
                    </button>
                  </td>
                  <td className="px-3 py-3">{catalogRow?.display ?? row.canonicalUrl}</td>
                  <td className="px-3 py-3 font-medium">{row.onHandCount}</td>
                  <td className="px-3 py-3">
                    <div className="font-medium">{row.committedCount}</div>
                    {row.committedCount > 0 ? (
                      <div className="text-xs text-[color:var(--odos-muted)]">
                        {[
                          row.reservedCount ? `${row.reservedCount} In office — not sent` : "",
                          row.outboundCount ? `${row.outboundCount} Outbound` : "",
                          row.atLabCount ? `${row.atLabCount} At Lab` : "",
                          row.inboundCount ? `${row.inboundCount} Inbound` : "",
                        ].filter(Boolean).join(" · ")}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-3">{row.holdCount}</td>
                  <td className="px-3 py-3">{row.dispensedCount}</td>
                  <td className="px-3 py-3">{row.location ?? ""}</td>
                  <td className="px-3 py-3">
                    {row.salePriceCents !== undefined ? `$${(row.salePriceCents / 100).toFixed(2)}` : ""}
                  </td>
                </tr>
                {expanded ? (
                  <tr className="border-t border-[color:var(--odos-line)] bg-[color:var(--odos-surface)]">
                    <td colSpan={8} className="px-5 py-4">
                      <table className="w-full text-left text-xs">
                        <thead className="text-[color:var(--odos-faint)]">
                          <tr>
                            <th className="pb-2">Unit ID</th>
                            <th className="pb-2">Received</th>
                            <th className="pb-2">Status</th>
                            <th className="w-40 pb-2" />
                          </tr>
                        </thead>
                        <tbody>
                          {rowUnits.map((unit) => (
                            <tr key={unit.id} className="border-t border-[color:var(--odos-line)]">
                              <td className="py-2 font-mono">{unit.id}</td>
                              <td className="py-2">{unit.receivedAt}</td>
                              <td className="py-2">{frameInventoryUnitStatusLabel(unit.status)}</td>
                              <td className="py-2 text-right">
                                {unit.status === "on_hand" ? (
                                  <button
                                    className="sidebar-button py-1"
                                    type="button"
                                    disabled={pendingIds.has(unit.id)}
                                    onClick={() => void markDispensed(unit.id)}
                                  >
                                    {pendingIds.has(unit.id) ? "Marking…" : "Mark Dispensed"}
                                  </button>
                                ) : null}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PosLookup({
  rows,
  inventory,
  query,
}: {
  rows: readonly FrameCatalogItem[];
  inventory: readonly PracticeFrameInventorySummary[];
  query: string;
}) {
  const matches = useMemo(() => rankFramePosLookupRows(rows, inventory, query), [rows, inventory, query]);
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {matches.map((match) => {
        const row = match.catalog;
        const inv = match.inventory;
        return (
          <div key={row.canonicalUrl} className="rounded border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">{row.display}</div>
                <div className="text-xs text-white/50">{row.sku}</div>
              </div>
              <div className="text-right text-sm">{inv?.onHandCount ?? 0} on hand</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FramesDataSettings() {
  const [settings, setSettings] = useState<FramesDataSubscriptionSettings>({ username: "", active: false });
  const [sourceFile, setSourceFile] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    let cancelled = false;
    loadFramesDataSubscriptionSettings()
      .then((loaded) => {
        if (!cancelled) setSettings(loaded);
      })
      .catch((err) => {
        if (!cancelled) setStatus(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setStatus("Saving…");
    try {
      await saveFramesDataSubscriptionSettings({
        practiceId: "odos-practice",
        actorId: actingPractitionerId(),
        settings,
      });
      setStatus("Saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="min-h-screen bg-bg text-white">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
        <OpticalNav active="settings" />
        <div className="rounded border border-white/10 bg-white/[0.03] p-5">
          <h1 className="text-lg font-semibold">Frames Data subscription</h1>
          <div className="mt-4 grid gap-4">
            <label className="grid gap-1 text-sm">
              <span className="text-white/60">Username</span>
              <input
                className="sidebar-input"
                value={settings.username}
                onChange={(event) => setSettings({ ...settings, username: event.target.value })}
              />
            </label>
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={settings.active}
                onChange={(event) => setSettings({ ...settings, active: event.target.checked })}
              />
              <span>Active subscription</span>
            </label>
            <div className="grid gap-1 text-sm text-white/70">
              <div>Last ingest: {settings.lastIngestAt ?? ""}</div>
              <div>Source: {settings.lastIngestSourceFile ?? ""}</div>
            </div>
            <label className="grid gap-1 text-sm">
              <span className="text-white/60">Upload latest catalog file</span>
              <input
                type="file"
                className="block text-sm text-white/70 file:mr-3 file:rounded file:border-0 file:bg-brand file:px-3 file:py-2 file:text-white"
                onChange={(event) => setSourceFile(event.target.files?.[0]?.name ?? "")}
              />
            </label>
            {sourceFile ? <div className="text-sm text-white/60">{sourceFile}</div> : null}
            <button className="sidebar-button w-fit" onClick={() => void save()} disabled={status === "Saving…"}>Save</button>
            {status ? <div className="text-sm text-white/60">{status}</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function CsvExportButton({ rows }: { rows: readonly FrameCatalogItem[] }) {
  const { role } = useRole();
  const allowed = canExportFrameCatalogCsv(role);
  const count = exportableFrameRows(rows).length;
  return (
    <button className="sidebar-button" disabled={!allowed}>
      Export CSV ({count})
    </button>
  );
}

function upsertByCanonicalUrl<T extends { readonly canonicalUrl: string }>(
  rows: readonly T[],
  updated: T,
): T[] {
  const index = rows.findIndex((row) => row.canonicalUrl === updated.canonicalUrl);
  if (index < 0) return [...rows, updated];
  return rows.map((row, rowIndex) => rowIndex === index ? updated : row);
}
