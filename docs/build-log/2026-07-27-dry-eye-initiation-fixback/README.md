# Dry-eye initiation fix-back browser proof

Captured on the local synthetic stack against patient `DE2 ProtocolProof`. No real patient data appears in these artifacts.

## Required proof

### IPL initiation proposal

Encounter `b4c3a02c…` shows the `Dry Eye — IPL Initiation` staging sheet with both canonical items selected:

- `series-prescription · series-ipl`
- `charge-seed · charge-ipl-package`

![IPL initiation proposal](ipl-init-proposal.jpg)

### IPL series tracker

The patient overview shows one active IPL series with four session slots. This is the allowed pre-first-session proof option: the tracker cannot render the stored 21–28-day interval until a completed session establishes the next-session due window, so it correctly displays `Ready to schedule`.

![IPL series tracker](ipl-series-tracker.jpg)

### At-home regimen proposal

Encounter `b4c3a02c…` shows only lid-hygiene counseling, warm-compress instruction, and artificial-tears education. No series prescription or charge seed is present.

![At-home regimen proposal](at-home-regimen-proposal.jpg)

### Combined IPL and RF visit

Encounter `316b699b…` has both `Dry Eye — IPL Initiation` and `Dry Eye — RF Initiation` applied independently. The patient tracker then shows two separate four-session series, with no combined series.

![Combined IPL and RF tracker](combined-ipl-rf-series.jpg)

## Combined-visit supporting frames

The chart frame supplies the source encounter provenance and visibly shows both protocols as applied:

![Combined encounter with both protocols applied](combined-encounter-applied.jpg)

The RF staging frame shows its independent series item and four-session package charge seed while IPL is already applied on the same encounter:

![RF proposal with IPL already applied](combined-rf-proposal-with-ipl-applied.jpg)

The live FHIR check for encounter `316b699b…` found two independently scoped staged charge proposals: `dry-eye-ipl-4-sessions` and `dry-eye-rf-4-sessions`. The current UI has no single surface that displays the encounter identifier, both charge proposals, and both tracker timelines simultaneously; the supporting chart and staging frames preserve that provenance without altering the UI for this evidence-only fix-back.
