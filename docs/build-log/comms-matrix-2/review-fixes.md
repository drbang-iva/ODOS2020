# Author review dispositions

- Response patient binding: read/save parsers require the requested Patient reference. Two new tests; 14/16 red, 16/16 restored, exits 1/0.
- Registration defaults unavailable: show the failure and Retry, allow registration without a preference payload so server defaults apply. Pending reads remain blocked. New MATRIX-2 tests cover the fallback; 21/23 red, 23/23 restored, exits 1/0.
- Browser startup: cleanup includes browser-launch failure. The old fixture required timeout termination; the corrected fixture exits naturally with the expected launch error. Ordinary browser tests: 8/8, exit 0.
- Screenshot timing: wait for actual fresh-read and save responses instead of a fixed delay. Twelve synthetic screen states captured, exit 0.
- Preflight colors: new UI classes now use existing theme tokens. Initial two hard blocks become zero; the guard is unchanged.
- Paper-form date: retain the existing UTC bound because the server validates against the UTC recorded-at date. A client-only local-date change could admit a date the server rejects. Coordinated local-calendar behavior is a follow-up for the independent evaluator, outside the specified server changes.

No base assertion was changed for these review fixes. New MATRIX-2 fixtures and tests were adjusted to exercise the corrected behavior. Full final UI: 1417/1417, exit 0. Final UI build and preflight: exit 0. The eight full-MCP failures also occur at the clean base; zero branch-only failures.
