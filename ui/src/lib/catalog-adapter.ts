import type { Basic, Bundle, Resource } from "@medplum/fhirtypes";
import { searchAll } from "./fhir-search";

export type CatalogItemBase = {
  id: string;
  active: boolean;
  refCount?: number;
};

export type CatalogCapabilities = {
  readonly reorder: boolean;
  readonly deactivate: boolean;
  readonly presetSeed: boolean;
  readonly groupBy?: boolean;
};

type Awaitable<T> = T | Promise<T>;

export interface CatalogAdapter<Item> {
  list(): Awaitable<Item[]>;
  save(item: Item): Awaitable<Item>;
  deactivate(item: Item): Awaitable<Item>;
  reorder?(ids: string[]): Awaitable<void>;
  readonly capabilities: CatalogCapabilities;
}

type ResourceCatalogClient = {
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: Record<string, string> | URLSearchParams | Array<[string, string]>,
  ): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(url: string): Promise<Bundle<T>>;
  create<T extends Resource>(resource: T, sourceTag: string): Promise<T>;
  update<T extends Resource>(resource: T, sourceTag: string): Promise<T>;
};

export function resourceCatalogAdapter<Item extends CatalogItemBase, R extends Resource>({
  resourceType,
  searchParams,
  client,
  sourceTag,
  capabilities,
  toItem,
  includeResource,
  buildResource,
  deactivateResource,
}: {
  resourceType: R["resourceType"];
  searchParams?: Record<string, string> | URLSearchParams | Array<[string, string]>;
  client: ResourceCatalogClient;
  sourceTag: string;
  capabilities: CatalogCapabilities;
  toItem: (resource: R) => Item;
  includeResource?: (resource: R) => boolean;
  buildResource: (item: Item) => R;
  deactivateResource: (item: Item) => R;
}): CatalogAdapter<Item> {
  if (capabilities.reorder) {
    throw new Error("Resource catalogs do not support reorder.");
  }

  async function write(resource: R): Promise<Item> {
    const saved = resource.id
      ? await client.update(resource, sourceTag)
      : await client.create(resource, sourceTag);
    return toItem(saved);
  }

  return {
    capabilities,
    async list() {
      const resources = await searchAll<R>(client, resourceType, searchParams);
      return resources.filter((resource) => includeResource?.(resource) ?? true).map(toItem);
    },
    async save(item) {
      return write(buildResource(item));
    },
    async deactivate(item) {
      if (!capabilities.deactivate) {
        throw new Error("This catalog does not allow deactivation.");
      }
      const resource = deactivateResource(item);
      if (!resource.id) {
        throw new Error(`Catalog item "${item.id}" must be saved before it can be deactivated.`);
      }
      return write(resource);
    },
  };
}

type BasicWriter = {
  create<T extends Basic>(resource: T, sourceTag: string): Promise<T>;
  update<T extends Basic>(resource: T, sourceTag: string): Promise<T>;
};

export interface CatalogDraftTransaction {
  readonly dirty: boolean;
  commit(): Promise<Basic | undefined>;
  discard(): Awaitable<string | void>;
}

export interface SingletonConfigDraft<Config extends object> extends CatalogDraftTransaction {
  readonly configKey: string;
  baseline(): Config;
  current(): Config;
  replace(config: Config): void;
  reconcile(config: Config, resource?: Basic): void;
  reset(config: Config, resource?: Basic): void;
}

export function createSingletonConfigDraft<Config extends object>({
  configKey,
  config,
  resource,
  buildResource,
  sourceTag,
  fhirClient,
}: {
  configKey: string;
  config: Config;
  resource?: Basic;
  buildResource: (config: Config, existing?: Basic) => Basic;
  sourceTag: string;
  fhirClient: BasicWriter;
}): SingletonConfigDraft<Config> {
  let persisted = clone(config);
  let draft = clone(config);
  let currentResource = resource ? clone(resource) : undefined;

  return {
    configKey,
    get dirty() {
      return JSON.stringify(draft) !== JSON.stringify(persisted);
    },
    baseline() {
      return clone(persisted);
    },
    current() {
      return clone(draft);
    },
    replace(next) {
      draft = clone(next);
    },
    reconcile(next, nextResource) {
      persisted = clone(next);
      currentResource = nextResource ? clone(nextResource) : undefined;
    },
    reset(next, nextResource) {
      persisted = clone(next);
      draft = clone(next);
      currentResource = nextResource ? clone(nextResource) : undefined;
    },
    async commit() {
      const built = buildResource(clone(draft), currentResource);
      const preservingIdentity: Basic = {
        ...built,
        ...(currentResource?.id ? { id: currentResource.id } : {}),
        ...(currentResource?.meta ? { meta: currentResource.meta } : {}),
      };
      const saved = currentResource?.id
        ? await fhirClient.update(preservingIdentity, sourceTag)
        : await fhirClient.create(preservingIdentity, sourceTag);
      currentResource = clone(saved);
      persisted = clone(draft);
      return clone(saved);
    },
    discard() {
      draft = clone(persisted);
    },
  };
}

export function singletonListAdapter<Item extends CatalogItemBase, Config extends object = Record<string, unknown>>(
  configKey: string,
  listPath: string,
  {
    draft,
    capabilities,
  }: {
    draft: SingletonConfigDraft<Config>;
    capabilities: CatalogCapabilities;
  },
): CatalogAdapter<Item> {
  if (draft.configKey !== configKey) {
    throw new Error(
      `Catalog adapter config key "${configKey}" does not match draft "${draft.configKey}".`,
    );
  }
  const path = listPath.split(".").filter(Boolean);
  if (path.length === 0) {
    throw new Error("Catalog adapter list path is required.");
  }

  return projectedListAdapter(draft, {
    capabilities,
    toRows(config) {
      const value = readPath(config as Record<string, unknown>, path);
      if (!Array.isArray(value)) {
        throw new Error(`Catalog list path "${listPath}" is not an array.`);
      }
      return clone(value) as Item[];
    },
    fromRows(config, items) {
      return writePath(config as Record<string, unknown>, path, clone(items)) as Config;
    },
  });
}

export function projectedListAdapter<Item extends CatalogItemBase, Config extends object>(
  draft: SingletonConfigDraft<Config>,
  {
    toRows,
    fromRows,
    capabilities,
  }: {
    toRows: (config: Config) => Item[];
    fromRows: (config: Config, items: Item[]) => Config;
    capabilities: CatalogCapabilities;
  },
): CatalogAdapter<Item> {
  function readItems(): Item[] {
    return clone(toRows(draft.current()));
  }

  function writeItems(items: Item[]): void {
    draft.replace(fromRows(draft.current(), clone(items)));
  }

  return {
    capabilities,
    list: readItems,
    save(item) {
      const items = readItems();
      const index = items.findIndex((candidate) => candidate.id === item.id);
      if (index === -1) {
        items.push(clone(item));
      } else {
        items[index] = clone(item);
      }
      writeItems(items);
      return clone(item);
    },
    deactivate(item) {
      if (!capabilities.deactivate) {
        throw new Error("This catalog does not allow deactivation.");
      }
      const deactivated = { ...clone(item), active: false };
      const items = readItems();
      const index = items.findIndex((candidate) => candidate.id === item.id);
      if (index === -1) {
        throw new Error(`Catalog item "${item.id}" was not found.`);
      }
      items[index] = deactivated;
      writeItems(items);
      return clone(deactivated);
    },
    ...(capabilities.reorder
      ? {
          reorder(ids: string[]) {
            const items = readItems();
            if (
              ids.length !== items.length ||
              new Set(ids).size !== items.length ||
              items.some((item) => !ids.includes(item.id))
            ) {
              throw new Error("Reorder ids must include every catalog item exactly once.");
            }
            const byId = new Map(items.map((item) => [item.id, item]));
            writeItems(ids.map((id) => clone(byId.get(id)!)));
          },
        }
      : {}),
  };
}

function readPath(root: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function writePath(
  root: Record<string, unknown>,
  path: string[],
  value: unknown,
): Record<string, unknown> {
  const next = clone(root);
  let current = next;
  for (const segment of path.slice(0, -1)) {
    const child = current[segment];
    current[segment] = isRecord(child) ? clone(child) : {};
    current = current[segment] as Record<string, unknown>;
  }
  current[path.at(-1)!] = value;
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
