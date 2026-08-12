# Fee Schedule Import P1 Verification Ledger

Access date: 2026-08-12

| Artifact | ODOS use | Primary source 1 | Primary source 2 | Status |
|---|---|---|---|---|
| RT / LT | Rejected from concept-level modifier storage because side is charge-specific | [CMS Medicare Claims Processing Manual, Chapter 4, sections 20.6.2-20.6.3](https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/clm104c04.pdf) | [CMS Medicare Coverage Database article A56869](https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleStatus=all&articleid=56869) | verified |
| 50 | Rejected from concept-level modifier storage because bilateral performance is charge-specific | [CMS Medicare Claims Processing Manual, Chapter 4, section 20.6.2](https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/clm104c04.pdf) | [CMS Medicare Coverage Database article A56670](https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleid=56670) | verified |

The CMS manual identifies `LT` as left side, `RT` as right side, and `50` as a bilateral procedure performed on both sides in the same operative session. The two Medicare Coverage Database articles independently agree with those meanings.

The importer treatment of a final `.50` suffix is a visible, operator-overridable heuristic. These sources verify modifier `50` semantics; they do not prove that every legacy `.50` suffix is a modifier.
