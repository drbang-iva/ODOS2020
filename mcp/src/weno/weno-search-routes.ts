import type { Application, Request, Response } from "express";
import type { AuthenticatedStaff } from "../payments/payment-charge-handler.js";
import {
  searchDrugs,
  WenoDrugSearchValidationError,
  type WenoDrugRow,
} from "../jobs/syncWenoDrugDatabase.js";
import {
  searchPharmacies,
  WenoPharmacySearchValidationError,
  type PharmacyDirectoryRow,
  type PharmacySearchInput,
  type PharmacySearchType,
} from "../jobs/syncWenoPharmacyDirectory.js";

export const WENO_SEARCH_RESULT_LIMIT = 25;

export interface WenoDrugSearchClient {
  search(query: string): Promise<WenoDrugRow[]>;
}

export interface WenoPharmacySearchClient {
  search(input: PharmacySearchInput): Promise<PharmacyDirectoryRow[]>;
}

export interface WenoSearchRouteDeps {
  authenticateService(): Promise<void>;
  authenticate(authHeader: string | undefined): Promise<AuthenticatedStaff | null>;
  drugs: WenoDrugSearchClient;
  pharmacies: WenoPharmacySearchClient;
}

export function registerWenoSearchRoutes(
  app: Pick<Application, "get">,
  deps: WenoSearchRouteDeps,
): void {
  app.get("/weno/drugs/search", async (req, res) => handleDrugSearch(req, res, deps));
  app.get("/weno/pharmacies/search", async (req, res) => handlePharmacySearch(req, res, deps));
}

async function handleDrugSearch(req: Request, res: Response, deps: WenoSearchRouteDeps): Promise<void> {
  try {
    await deps.authenticateService();
    if (!await deps.authenticate(req.header("authorization"))) {
      res.status(401).json({ error: "Authentication required to search the Formulary." });
      return;
    }
    const query = queryString(req.query.q, "q") ?? "";
    searchDrugs([], query);
    const results = await deps.drugs.search(query);
    res.json({ results: results.slice(0, WENO_SEARCH_RESULT_LIMIT).map(shapeDrugResult) });
  } catch (error) {
    console.error("odos-mcp: /weno/drugs/search failed:", error);
    if (!res.headersSent) {
      if (error instanceof WenoDrugSearchValidationError || error instanceof WenoQueryValidationError) {
        res.status(400).json({ error: error.message });
      } else {
        res.status(500).json({ error: "Formulary search failed." });
      }
    }
  }
}

async function handlePharmacySearch(req: Request, res: Response, deps: WenoSearchRouteDeps): Promise<void> {
  try {
    await deps.authenticateService();
    if (!await deps.authenticate(req.header("authorization"))) {
      res.status(401).json({ error: "Authentication required to search the Directory." });
      return;
    }
    const input = pharmacySearchInput(req);
    searchPharmacies([], input);
    const results = await deps.pharmacies.search(input);
    res.json({ results: results.slice(0, WENO_SEARCH_RESULT_LIMIT).map(shapePharmacyResult) });
  } catch (error) {
    console.error("odos-mcp: /weno/pharmacies/search failed:", error);
    if (!res.headersSent) {
      if (error instanceof WenoPharmacySearchValidationError || error instanceof WenoQueryValidationError) {
        res.status(400).json({ error: error.message });
      } else {
        res.status(500).json({ error: "Directory search failed." });
      }
    }
  }
}

function pharmacySearchInput(req: Request): PharmacySearchInput {
  const searchTypeValue = queryString(req.query.searchType, "searchType");
  if (searchTypeValue && !isPharmacySearchType(searchTypeValue)) {
    throw new WenoQueryValidationError("Pharmacy search type must be local-retail or mail-order.");
  }
  const searchType: PharmacySearchType | undefined = searchTypeValue === "local-retail" || searchTypeValue === "mail-order"
    ? searchTypeValue
    : undefined;
  return {
    state: queryString(req.query.state, "state"),
    zip: queryString(req.query.zip, "zip"),
    city: queryString(req.query.city, "city"),
    county: queryString(req.query.county, "county"),
    searchType,
    onWeno: queryBoolean(req.query.onWeno, "onWeno"),
    name: queryString(req.query.name, "name"),
    street: queryString(req.query.street, "street"),
    open24hr: queryBoolean(req.query.open24hr, "open24hr"),
    all: queryBoolean(req.query.all, "all"),
    includeTestPharmacies: queryBoolean(req.query.includeTestPharmacies, "includeTestPharmacies"),
  };
}

function shapeDrugResult(row: WenoDrugRow) {
  return {
    drugDbCode: row.drugDbCode,
    drugDbCodeQualifier: row.drugDbCodeQualifier,
    quantityUnitOfMeasureCode: row.quantityUnitOfMeasureCode,
    psnDescription: row.psnDescription,
    route: row.route,
    strength: row.strength,
  };
}

function shapePharmacyResult(row: PharmacyDirectoryRow) {
  return {
    ncpdpId: row.ncpdpId,
    businessName: row.businessName,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    state: row.state,
    zip: row.zip,
    phone: row.phone,
    onWeno: row.onWeno,
  };
}

function queryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new WenoQueryValidationError(`WENO search ${field} must be a single value.`);
  }
  return value;
}

function queryBoolean(value: unknown, field: string): boolean | undefined {
  const text = queryString(value, field);
  if (text === undefined) return undefined;
  if (text === "true") return true;
  if (text === "false") return false;
  throw new WenoQueryValidationError(`WENO search ${field} must be true or false.`);
}

function isPharmacySearchType(value: string): value is PharmacySearchType {
  return value === "local-retail" || value === "mail-order";
}

class WenoQueryValidationError extends Error {}
