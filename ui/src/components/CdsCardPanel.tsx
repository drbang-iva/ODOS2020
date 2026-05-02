import { isFreshCdsCard, type CdsCardViewModel } from "../lib/cds-cards";

interface Props {
  cards: readonly CdsCardViewModel[];
  now?: Date;
}

const INDICATOR_STYLES: Record<CdsCardViewModel["indicator"], string> = {
  info: "border-sky-300/40 bg-sky-500/10 text-sky-100",
  warning: "border-amber-300/50 bg-amber-500/10 text-amber-100",
  critical: "border-rose-300/50 bg-rose-500/10 text-rose-100",
};

export function CdsCardPanel({ cards, now = new Date() }: Props) {
  const freshCards = cards.filter((card) => isFreshCdsCard(card, now));
  if (!freshCards.length) {
    return null;
  }
  return (
    <aside className="border-l border-white/10 bg-black/20 p-4">
      <div className="space-y-3">
        {freshCards.map((card) => (
          <article
            key={card.uuid}
            className={["rounded-md border p-3 shadow-sm", INDICATOR_STYLES[card.indicator]].join(" ")}
          >
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-sm font-semibold leading-5">{card.summary}</h2>
              <span className="shrink-0 rounded bg-white/10 px-2 py-1 text-[11px] uppercase tracking-normal">
                {card.dsi_type}
              </span>
            </div>
            {card.detail && <p className="mt-2 text-sm leading-5 text-white/80">{card.detail}</p>}
            <dl className="mt-3 grid gap-2 text-xs text-white/65">
              <div>
                <dt className="font-semibold text-white/75">Developer</dt>
                <dd>{card.source_attributes.developer_identity}</dd>
              </div>
              <div>
                <dt className="font-semibold text-white/75">Evidence</dt>
                <dd>{card.source_attributes.evidence_basis_citation}</dd>
              </div>
              <div>
                <dt className="font-semibold text-white/75">Risk Management</dt>
                <dd>{card.intervention_risk_management.risk_mitigation}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </aside>
  );
}
