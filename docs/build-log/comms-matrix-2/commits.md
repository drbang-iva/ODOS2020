# Implementation commits

Original step commits were preserved through the approved S1 resumption. Each production commit belongs to one spec step; follow-ups are isolated. The final evidence-only commit contains the packet.

- `8f1e725a` Report Patient write versions for communication dialogs
- `180360d3` Serve communication preference defaults to screens
- `6b84381d` Parse communication preference responses and evidence reports
- `2fa7780d` U2 communication preference control and confirmation draft
- `3a7b2fe6` Omit unset evidence report query filters
- `8ef938d2` Read communication write versions from returned Patient resources
- `7ef9e821` Keep communication dialog writes synchronized with demographics
- `28a3f610` U4 registration communication preferences and confirmation
- `3f3420b3` Follow communication preferences in education sends
- `737bfd53` Keep preference recovery scoped and evidence labels factual
- `ff1a7fd3` Show chart texting suppression from the server summary
- `df6aba84` Show consent evidence gaps and CSV export
- `f4694add` U2: keep confirmation controls readable
- `4f4c3f87` U7: keep evidence filters readable

Review follow-ups, each isolated by spec step:

- `504ea635` Bind preference responses to the requested patient
- `415fb32d` U2: use the shared focus color token
- `5b1a9a91` U3: use the shared notice color token
- `18683679` U2: use theme contrast for preference saves
- `ab2518a6` U3: use theme surfaces for communication preferences
- `56490038` Close consent evidence test servers when browser launch fails
- `4f99d7aa` Allow registration when communication defaults are unavailable
