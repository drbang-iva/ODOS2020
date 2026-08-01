import { useMemo, useState } from "react";
import { clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { fhir, type WenoPharmacySearchResult } from "../../lib/fhir";
import {
  pharmacyDisplay,
  type MedicationOrderPharmacy,
} from "../../lib/fhir-medication-order";
import { OdosSearchPicker } from "../inputs/OdosSearchPicker";

export type DirectoryResult = WenoPharmacySearchResult;

export interface PharmacyDirectorySearchApi {
  searchDirectory(input: {
    state: string;
    place: string;
    searchType: "local-retail" | "mail-order";
  }, signal?: AbortSignal): Promise<DirectoryResult[]>;
}

export interface PharmacySelection {
  pharmacy: string;
  pharmacyNcpdpId?: string;
  pharmacyDetails?: MedicationOrderPharmacy;
}

interface PharmacyDirectoryPickerProps {
  pharmacy: string;
  pharmacyNcpdpId?: string;
  label?: string;
  stateLabel?: string;
  allowFreeText?: boolean;
  searchApi?: PharmacyDirectorySearchApi;
  searchDelayMs?: number;
  onChange: (selection: PharmacySelection) => void;
}

type DirectorySelection =
  | { kind: "coded"; result: DirectoryResult }
  | { kind: "free-text"; text: string };

const DEFAULT_WENO_DIRECTORY_SEARCH_API: PharmacyDirectorySearchApi = {
  searchDirectory(input, signal) {
    return fhir.searchWenoDirectory(clinicalGraphApiBase(), input, signal);
  },
};

export function PharmacyDirectoryPicker({
  pharmacy,
  pharmacyNcpdpId,
  label = "Directory ZIP or city",
  stateLabel = "Directory state",
  allowFreeText = true,
  searchApi = DEFAULT_WENO_DIRECTORY_SEARCH_API,
  searchDelayMs,
  onChange,
}: PharmacyDirectoryPickerProps) {
  const [directoryState, setDirectoryState] = useState("");
  const [directorySearchType, setDirectorySearchType] =
    useState<"local-retail" | "mail-order">("local-retail");
  const searchDirectoryOptions = useMemo(() => async (query: string, signal: AbortSignal) => {
    if (!directoryState.trim()) throw new Error("Enter the pharmacy state before searching.");
    return (await searchApi.searchDirectory({
      place: query,
      state: directoryState.trim(),
      searchType: directorySearchType,
    }, signal)).map((result, index) => ({
      value: result.ncpdpId || `${result.businessName}:${index}`,
      label: result.businessName,
      description: directoryAddress(result),
      item: { kind: "coded", result } satisfies DirectorySelection,
    }));
  }, [directorySearchType, directoryState, searchApi]);

  return (
    <div>
      <OdosSearchPicker<DirectorySelection>
        label={label}
        value={pharmacy ? pharmacyNcpdpId ?? `free:${pharmacy}` : ""}
        selectedLabel={pharmacy}
        placeholder="Search by ZIP or city"
        search={searchDirectoryOptions}
        searchDelayMs={searchDelayMs}
        createLabel={allowFreeText ? "Use as written" : undefined}
        onCreate={allowFreeText
          ? async (text) => ({
              value: `free:${text}`,
              label: text,
              item: { kind: "free-text", text } satisfies DirectorySelection,
            })
          : undefined}
        onClear={() => onChange({ pharmacy: "" })}
        onSelect={(option) => {
          if (option.item.kind === "coded") {
            const details = pharmacyFromDirectoryResult(option.item.result);
            onChange({
              pharmacy: pharmacyDisplay(details),
              pharmacyNcpdpId: details.ncpdpId,
              pharmacyDetails: details,
            });
          } else {
            onChange({ pharmacy: option.item.text });
          }
        }}
      />
      {pharmacyNcpdpId && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-medium normal-case tracking-normal text-[color:var(--odos-emerald)]">
          <span className="rounded-full border border-[color:var(--odos-emerald)] bg-[color:var(--odos-surface-2)] px-2 py-1">Coded — from the WENO Directory</span>
          <span>NCPDP {pharmacyNcpdpId}</span>
        </div>
      )}
      <div className="mt-3 grid grid-cols-[5rem_1fr] gap-2">
        <input
          aria-label={stateLabel}
          className="sidebar-input uppercase"
          maxLength={2}
          value={directoryState}
          onChange={(event) => setDirectoryState(event.target.value.toUpperCase())}
          placeholder="State"
        />
        <div className="flex rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface-2)] p-1 text-xs">
          <button
            type="button"
            aria-pressed={directorySearchType === "local-retail"}
            className={directorySearchType === "local-retail"
              ? "rounded bg-[color:var(--odos-accent-tint-hi)] px-3 py-1.5 text-[color:var(--odos-text)]"
              : "px-3 py-1.5 text-[color:var(--odos-muted)]"}
            onClick={() => setDirectorySearchType("local-retail")}
          >
            Local
          </button>
          <button
            type="button"
            aria-pressed={directorySearchType === "mail-order"}
            className={directorySearchType === "mail-order"
              ? "rounded bg-[color:var(--odos-accent-tint-hi)] px-3 py-1.5 text-[color:var(--odos-text)]"
              : "px-3 py-1.5 text-[color:var(--odos-muted)]"}
            onClick={() => setDirectorySearchType("mail-order")}
          >
            Mail order
          </button>
        </div>
      </div>
    </div>
  );
}

export function pharmacyFromDirectoryResult(result: DirectoryResult): MedicationOrderPharmacy {
  return {
    ncpdpId: result.ncpdpId,
    ...(result.npi ? { npi: result.npi } : {}),
    name: result.businessName,
    addressLine1: result.addressLine1,
    ...(result.addressLine2 ? { addressLine2: result.addressLine2 } : {}),
    city: result.city,
    state: result.state,
    postalCode: result.zip,
    phone: result.phone,
  };
}

function directoryAddress(result: DirectoryResult): string {
  return [
    [result.addressLine1, result.addressLine2].filter(Boolean).join(" "),
    [result.city, result.state, result.zip].filter(Boolean).join(" "),
  ].filter(Boolean).join(" · ");
}
