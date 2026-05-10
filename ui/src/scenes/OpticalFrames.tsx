import { useEffect, useMemo, useState } from "react";
import {
  canExportFrameCatalogCsv,
  exportableFrameRows,
  loadFramesDataSubscriptionSettings,
  loadPracticeFrameInventory,
  rankFramePosLookupRows,
  saveFramesDataSubscriptionSettings,
  searchFrameCatalog,
  type FrameCatalogItem,
  type FramesDataSubscriptionSettings,
  type PracticeFrameInventoryItem,
} from "../lib/optical-frames";
import { useRole } from "../lib/role-context";

type OpticalFramesRoute = "catalog" | "inventory" | "lookup" | "settings";

export function OpticalFrames({ route }: { route: OpticalFramesRoute }) {
  const [catalogRows, setCatalogRows] = useState<FrameCatalogItem[]>([]);
  const [inventoryRows, setInventoryRows] = useState<PracticeFrameInventoryItem[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setError(null);
      try {
        const [catalog, inventory] = await Promise.all([
          searchFrameCatalog(query),
          route === "catalog" ? Promise.resolve([]) : loadPracticeFrameInventory(),
        ]);
        if (!cancelled) {
          setCatalogRows(catalog);
          setInventoryRows(inventory);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [query, route]);

  if (route === "settings") {
    return <FramesDataSettings />;
  }

  return (
    <div className="min-h-screen bg-bg text-white">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-6">
        <OpticalNav active={route} />
        <div className="flex flex-wrap items-center gap-3">
          <input
            className="h-10 min-w-72 rounded border border-white/15 bg-bg-deep px-3 text-sm outline-none focus:border-brand"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="SKU, GTIN, brand, model"
          />
          {route === "inventory" ? <CsvExportButton rows={catalogRows} /> : null}
        </div>
        {error ? <div className="rounded border border-red-500/50 bg-red-950/30 p-3 text-sm text-red-100">{error}</div> : null}
        {route === "catalog" ? <CatalogTable rows={catalogRows} /> : null}
        {route === "inventory" ? <InventoryTable rows={inventoryRows} catalog={catalogRows} /> : null}
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

function CatalogTable({ rows }: { rows: readonly FrameCatalogItem[] }) {
  return (
    <div className="overflow-hidden rounded border border-white/10">
      <table className="w-full table-fixed border-collapse text-left text-sm">
        <thead className="bg-white/5 text-white/60">
          <tr>
            <th className="w-1/4 px-3 py-2">Frame</th>
            <th className="w-1/5 px-3 py-2">Identifiers</th>
            <th className="w-1/5 px-3 py-2">Measurements</th>
            <th className="w-1/5 px-3 py-2">Publicity</th>
            <th className="w-24 px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.canonicalUrl} className="border-t border-white/10">
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
                <button className="sidebar-button w-full">Add</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InventoryTable({ rows, catalog }: { rows: readonly PracticeFrameInventoryItem[]; catalog: readonly FrameCatalogItem[] }) {
  const catalogByUrl = useMemo(() => new Map(catalog.map((row) => [row.canonicalUrl, row])), [catalog]);
  return (
    <div className="overflow-hidden rounded border border-white/10">
      <table className="w-full table-fixed text-left text-sm">
        <thead className="bg-white/5 text-white/60">
          <tr>
            <th className="px-3 py-2">Frame</th>
            <th className="w-24 px-3 py-2">Qty</th>
            <th className="w-36 px-3 py-2">Status</th>
            <th className="w-40 px-3 py-2">Location</th>
            <th className="w-32 px-3 py-2">Sale</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const catalogRow = catalogByUrl.get(row.canonicalUrl);
            return (
              <tr key={row.id || row.canonicalUrl} className="border-t border-white/10">
                <td className="px-3 py-3">{catalogRow?.display ?? row.canonicalUrl}</td>
                <td className="px-3 py-3">{row.qtyOnHand}</td>
                <td className="px-3 py-3">{row.status}</td>
                <td className="px-3 py-3">{row.location ?? ""}</td>
                <td className="px-3 py-3">{row.salePriceCents ? `$${(row.salePriceCents / 100).toFixed(2)}` : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PosLookup({ rows, inventory, query }: { rows: readonly FrameCatalogItem[]; inventory: readonly PracticeFrameInventoryItem[]; query: string }) {
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
              <div className="text-right text-sm">{inv?.qtyOnHand ?? 0} on hand</div>
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
    await saveFramesDataSubscriptionSettings({
      practiceId: "osod-practice",
      actorId: "practice-admin",
      settings,
    });
    setStatus("Saved");
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
            <button className="sidebar-button w-fit" onClick={() => void save()}>Save</button>
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
