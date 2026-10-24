# Separate legacy workspace overflow

Status: OPEN, outside TUX-01 through TUX-06 standalone Tasks scope. No fix or acceptance is claimed for this legacy320px condition.

During11f82a8 browser acceptance, the new /tasks viewport loop left the subsequent existing /workspace persistence journey at320x844. Every six-width Tasks layout/title/action/search-padding assertion passed, as did the actual320px Start command and its database assertion. The later desktop legacy document-width check failed at tests/e2e/task.spec.ts:199. The mobile case passed. The broad receipt retains56 passes/1 failure.

The standalone stylesheet requires a register root absent from the legacy route. No legacy markup, permissions or workflow were changed. The exact overflowing child remains unisolated; do not infer a root cause from the width assertion alone.

The test now restores its original project viewport before the separate legacy continuation. It keeps all six-width register assertions, the actual320px command/persistence checks, and the original legacy overflow assertion at baseline Desktop Chrome/Pixel7 dimensions. Independent review accepted this isolation. Corrected desktop/mobile journeys plus identity passed3/3 on73b4136.

Private disposable-fixture evidence: .env.tasks-ux-fix-20261023/selected-acceptance.json and its trace; release-browser.json. This is not retained operational data.
