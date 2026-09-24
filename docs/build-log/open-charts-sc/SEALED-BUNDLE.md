# Open Charts C — sealed coder bundle

Open charts now appears after Requests on both desk docks. Prior-day and older counts use the alarm badge; today-only counts use a plain badge. The panel shows desk fields only and has no chart navigation.

R2 applied only the granted initialOpenCharts prop at ui/tests/officeChannel.test.tsx:84. Its existing assertions and all other lines remain unchanged.

Base: 2136e18c41f5846cd3240de236181afdeccfdd1b.
Branch: drbang-iva/open-charts-sc-desk-badge.

Full UI after R2: `npm --prefix ui test` — tests 1909 / pass 1909 / fail 0 / skipped 0; exit 0.
Full MCP at the same product implementation: tests 6479 / pass 6420 / fail 0 / skipped 59; exit 0.
Three typechecks exit 0; preflight 0 warnings / 0 hard blocks.
P1–P6 and C1–C10 red/green evidence, full commands, and R1 history are in R1-SEALED-BUNDLE.md.

Fresh-stack C11 proof, final PR URL, and review status will be recorded after execution.
NOT EVALUATED — independent evaluation has not run.

needs-review
