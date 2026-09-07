# Fee Schedule Import P1 Verification Ledger

Access date: 2026-08-12; RT/LT sources refreshed 2026-09-07

| Artifact | ODOS use | Primary source 1 | Primary source 2 | Status |
|---|---|---|---|---|
| RT / LT | Rejected from concept-level modifier storage because side is charge-specific. At charge materialization, OD/OS may map to RT/LT only for a procedure concept on an explicit eligibility allowlist; the shipped allowlist is empty. | [CMS Medicare Claims Processing Manual, Chapter 4, sections 20.6.2-20.6.3](https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/clm104c04.pdf) | [Noridian JF Part B modifier guidance](https://med.noridianmedicare.com/web/jfb/topics/modifiers) | verified meaning; per-procedure and per-payer eligibility not asserted |
| 50 | Rejected from concept-level modifier storage because bilateral performance is charge-specific | [CMS Medicare Claims Processing Manual, Chapter 4, section 20.6.2](https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/clm104c04.pdf) | [CMS Medicare Coverage Database article A56670](https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleid=56670) | verified |

The CMS manual identifies `LT` as left side, `RT` as right side, and `50` as a bilateral procedure performed on both sides in the same operative session. The listed sources independently agree with those meanings.

The gated materialization link does not establish modifier eligibility for any procedure or payer.

The importer treatment of a final `.50` suffix is a visible, operator-overridable heuristic. These sources verify modifier `50` semantics; they do not prove that every legacy `.50` suffix is a modifier.
