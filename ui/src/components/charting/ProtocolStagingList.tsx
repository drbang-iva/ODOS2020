import type { ProtocolItem } from "../../lib/protocol-authoring";

export function ProtocolStagingList({
  items,
  selections,
  onToggle,
  preview = false,
}: {
  items: ProtocolItem[];
  selections: Record<string, boolean>;
  onToggle?: (itemKey: string, selected: boolean) => void;
  preview?: boolean;
}) {
  return (
    <div className="space-y-2" data-testid={preview ? "protocol-staging-preview" : "protocol-staging-list"}>
      {items.map((item) => (
        <label
          key={item.itemKey}
          className="flex items-start gap-3 rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface)] p-3"
        >
          <input
            type="checkbox"
            checked={selections[item.itemKey] ?? item.defaultSelected}
            disabled={!onToggle}
            onChange={(event) => onToggle?.(item.itemKey, event.target.checked)}
            className="mt-1 h-4 w-4 accent-[var(--odos-accent)]"
          />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-[color:var(--odos-text)]">
              {protocolItemLabel(item)}
            </span>
            <span className="mt-0.5 block text-xs text-[color:var(--odos-muted)]">
              {item.itemType} · {item.itemKey}
              {protocolItemDetail(item) ? ` · ${protocolItemDetail(item)}` : ""}
              {item.capture ? ` · ${item.capture.source}` : ""}
            </span>
          </span>
          {item.itemType === "charge-seed" && (
            <span className="rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-surface-2)] px-2 py-1 text-xs text-[color:var(--odos-muted)]">
              {Array.isArray(item.payload.chargeRuleRefs) && item.payload.chargeRuleRefs.length > 0
                ? "coverage review"
                : "no rule"}
            </span>
          )}
        </label>
      ))}
    </div>
  );
}

export function protocolItemLabel(item: ProtocolItem): string {
  return humanize(String(
    item.payload.procedureConceptKey ??
    item.payload.orderableKey ??
    item.payload.topicKey ??
    item.payload.assetRef ??
    item.payload.instructionKey ??
    item.payload.findingDefKey ??
    item.itemKey
  ));
}

function protocolItemDetail(item: ProtocolItem): string {
  if (item.itemType === "follow-up" && item.payload.interval) {
    return `${item.payload.interval} ${String(item.payload.unit ?? "")}`.trim();
  }
  if (item.itemType === "order" && item.payload.performContext) {
    return humanize(String(item.payload.performContext));
  }
  if (item.itemType === "education" && item.payload.deliveryMode) {
    return humanize(String(item.payload.deliveryMode));
  }
  return "";
}

function humanize(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
