# Pagination author proof

Contract §3.9 / V8: both stores collect every validated page; malformed bundles, entries without resource/id, foreign next URLs, and cycles throw typed upstream (status 502). Invalid stored Basic payloads with valid resource/id still skip as before.

TDD: nine new tests initially failed; restored implementation 9/9. Focused existing store/search suites plus new tests: 31/31. Reader/writer/parity plus these suites: 285/285. MCP build exit 0. No existing assertion changed. All new assertions map V8 and §3.9. No captures or divergences changed.

NOT EVALUATED.
