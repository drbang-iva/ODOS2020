# Assessment origin projection correction — W141 / T18

The served Assessment entry sheet at 97fe4799 lacked the required origin text. An unscoped findings GET returns an empty selected-diagnosis `findings` list and all canonical rows in `searchIndex`. The T18 fixture incorrectly returned its rows in both collections.

The fixture now returns `findings: []` when the request has no Condition parameter, while preserving the canonical rows in `searchIndex`. T18 assertions are unchanged. Correcting only the fixture produced 8 pass / 1 fail (`assessment-unscoped-red.log`). Reading `projection.searchIndex` in Assessment restored 9/9 (`assessment-unscoped-green.log`), and TypeScript exited 0. Full UI at c587bf96: 1734 pass, 0 fail, 0 skipped, 0 todo. The before screenshot is retained under served-route/screens; the supplemental served proof verifies the repaired actual entry sheet.
