# pricewatch QA test plan

Working doc. Numeric thresholds are committed targets — change them in code, change them here.

## Acceptance criteria

### 1. Inbox upload
- AC-INB-1: Given Inbox is open, When user drops a single PDF under 10 MB onto the drop zone, Then a queue row appears within 200 ms with status `queued`, filename, and a spinner.
- AC-INB-2: Given multiple files are dropped at once, When 5 files are added, Then 5 rows appear in queue order and processing is serialized (max 1 active parse at a time, no UI freeze >100 ms).
- AC-INB-3: Given a file with an unsupported MIME (e.g. `.docx`), When dropped, Then the row shows `unsupported` in red and is not written to `documents`.
- AC-INB-4: Given a parse succeeds, When done, Then row state goes `queued → parsing → matched → done`, and a toast shows count of new line items.
- AC-INB-5: Given a parse fails (no regex matched, generic fallback also empty), When done, Then row shows `needs review` with a "view raw text" affordance.
- AC-INB-6: Given the user reloads mid-queue, When app restarts, Then unfinished rows are not silently dropped — they reappear as `interrupted` and can be retried.

### 2. PDF text extraction
- AC-PDF-1: Given a text-based PDF (chase fixture), When extracted via pdf.js, Then ≥95% of merchant strings in the fixture appear verbatim in extracted text.
- AC-PDF-2: Given a scanned image-only PDF, When detected (zero text layer), Then app routes to OCR pipeline instead of failing silently.
- AC-PDF-3: Given a multi-page PDF, When extracted, Then page boundaries are preserved as `\f` or `\n\n` so date headers don't merge into amounts.
- AC-PDF-4: Given an encrypted PDF, When opened, Then UI shows `password protected — open in viewer first` rather than a JS exception.
- AC-PDF-5: Given pdf.js worker fails to load (offline CDN), When extraction starts, Then user sees `pdf engine unavailable, retrying` and the row stays `queued`, not `failed`.

### 3. Image OCR
- AC-OCR-1: Given a clean phone photo of a Walmart receipt at >1500px width, When OCR'd via tesseract.js, Then ≥80% of price tokens (regex `\d+\.\d{2}`) match the expected fixture.
- AC-OCR-2: Given a rotated image (90°/180°/270°), When OCR'd, Then app auto-rotates or detects orientation; total recall on prices stays ≥70%.
- AC-OCR-3: Given a blurry image, When OCR'd, Then matcher tolerance compensates; final line-item match rate ≥60% (worse but not zero).
- AC-OCR-4: Given tesseract.js cold-load (first use), When user uploads, Then loading state shows `loading OCR engine (~10MB)` and the tesseract bundle is cached for subsequent uploads.
- AC-OCR-5: Given an image with no detectable text, When OCR returns empty, Then the doc is stored but flagged `needs review`, not silently dropped.

### 4. Line-item parsing
- AC-PRS-1: Given the walmart fixture, When parsed, Then output equals `expected_parsed_walmart.json` field-for-field (`store`, `date`, `total`, `currency`, every `lineItem`).
- AC-PRS-2: Given a chase bank statement, When parsed, Then each transaction line yields one `transaction` row (no line-items, since bank statements are aggregate); merchant, date, amount populated.
- AC-PRS-3: Given mixed thousands separators (`1,234.56` vs `1.234,56`), When currency is INR/USD, Then dot-decimal is used; EUR may use comma — log a warning but pick the rightmost separator as decimal.
- AC-PRS-4: Given a receipt with no recognized header, When parsed, Then generic fallback fires: extract any `<name> <price>` pairs and tag store as `Unknown`.
- AC-PRS-5: Given a receipt with negative lines (refund, coupon), When parsed, Then those lines have `qty: 1`, negative `lineTotal`, and don't break `subtotal === sum(lineTotals)` reconciliation (within 0.02 currency tolerance).
- AC-PRS-6: Given the parser sees `SUBTOTAL`, `TAX`, `TOTAL` lines, When parsed, Then those are not added as line items.

### 5. Item matching (canonicalization)
- AC-MTC-1: Given `COKE 2L` and `COCA-COLA 2 LITER` after normalization (lowercase, strip qty, strip punctuation), When compared, Then Levenshtein similarity ≥0.85 and they collapse to the same `canonicalItemId`.
- AC-MTC-2: Given an exact-match alias exists in `itemAliases`, When seen again, Then no Levenshtein call is made (cache hit) and match is O(1).
- AC-MTC-3: Given `MILK 1GAL` vs `WHOLE MILK GALLON`, When normalized, Then similarity should still be ≥0.85 because qty normalizer strips `1gal`/`gallon` to a unit token.
- AC-MTC-4: Given two truly different items that score 0.84, When matched, Then they stay separate; threshold is a hard cutoff (no rounding).
- AC-MTC-5: Given a user manually merges item A into item B in Item detail, When merged, Then a new `itemAlias` row is written and future imports route A → B without re-asking.
- AC-MTC-6: Given merchant names `WAL-MART #1234`, `WALMART SUPERCENTER`, `WM SUPERCENTER`, When merchant-rule matcher runs, Then all three resolve to canonical store `Walmart` (rule-based, not Levenshtein).

### 6. Items list
- AC-ITL-1: Given ≥1 line item exists, When user opens Items tab, Then list renders within 300 ms for up to 1,000 items (virtualized or paginated).
- AC-ITL-2: Given an item has 2+ purchases, When listed, Then current price = most recent purchase unitPrice and delta = `(current - prior) / prior * 100`, with sign and color (green ↓, red ↑).
- AC-ITL-3: Given an item has 1 purchase, When listed, Then delta column shows `—` (em dash), not `0%` or `NaN`.
- AC-ITL-4: Given user sorts by `biggest jump`, When sorted, Then items with `|delta| ≥ 10%` rise to top; ties break by most recent date.
- AC-ITL-5: Given currency is changed in Settings, When Items refreshes, Then prices display in the new currency symbol but stored values do not mutate (display-only conversion is not done — single-currency app, just symbol swap if user is migrating).

### 7. Item detail
- AC-ITD-1: Given an item with 5 purchases, When detail opens, Then a sparkline of unitPrice over time renders with min/max/avg labels.
- AC-ITD-2: Given user taps a data point, When tapped, Then the source transaction (store, date) is shown.
- AC-ITD-3: Given user taps "merge with…", When opens, Then a search picker over other items shows top 10 by similarity, sorted descending.
- AC-ITD-4: Given user taps "rename", When saved, Then `itemAliases` updates the canonical display name; raw `lineItems.name` values stay untouched (audit trail).

### 8. Statements list
- AC-STM-1: Given documents exist, When Statements opens, Then they group by `YYYY-MM` headers, newest first.
- AC-STM-2: Given user taps a statement row, When opened, Then the original Blob is fetched from `documents` store and rendered (PDF inline, image as `<img>`).
- AC-STM-3: Given user deletes a statement, When confirmed, Then the doc, its transaction, and its lineItems are removed transactionally; orphan canonical items stay (price history is precious).
- AC-STM-4: Given a statement has no parsed transaction (parse failed), When listed, Then it still appears with a `needs review` badge.

### 9. Insights
- AC-INS-1: Given ≥3 items have ≥2 purchases each, When Insights opens, Then "biggest jumps" shows top 5 by absolute % delta with current vs prior.
- AC-INS-2: Given purchase history exists, When "most-bought" computed, Then ranking is by total qty across all purchases (not transaction count).
- AC-INS-3: Given an item was bought at multiple stores, When "cheapest store" computed, Then per-item cheapest store is shown using min(unitPrice) across last 90 days.
- AC-INS-4: Given <3 items qualify, When Insights opens, Then a friendly empty state appears, not blank panels.
- AC-INS-5: Given categories are inferred from merchant rules (Walmart→Groceries, Shell→Fuel), When "top categories" computed, Then it sums spend per category over the last 30 days; uncategorized falls under `Other`.

### 10. Settings / export
- AC-SET-1: Given user changes theme to dark, When toggled, Then `prefers-color-scheme` is overridden and persisted in `settings`; reload preserves it.
- AC-SET-2: Given user changes currency from USD to INR, When confirmed, Then symbol updates app-wide; numeric values are NOT converted (single global setting, retroactive symbol only).
- AC-SET-3: Given user taps "export JSON", When exported, Then a single JSON blob includes `settings`, `transactions`, `lineItems`, `merchantRules`, `itemAliases`, plus a `schemaVersion` integer; documents (Blobs) are excluded by default with a note.
- AC-SET-4: Given user imports a previously exported JSON, When imported into a clean install, Then all rows round-trip identically (deep-equal except `id` regeneration is allowed only if explicit re-key flag is set).
- AC-SET-5: Given user taps "clear all", When confirmed via second tap, Then every store is cleared, theme/currency reset to defaults, and the user lands on Inbox empty state.

## Edge cases

Malformed inputs:
1. Encrypted PDF (password-protected) — must show actionable error, not a stack trace.
2. PDF with embedded fonts that pdf.js can't decode — text comes out as `□□□`; parser must not match garbage as merchant.
3. Rotated image (EXIF orientation 3, 6, 8) — OCR engine receives the right orientation.
4. Blurry image (low contrast, JPEG compression artifacts) — falls back to `needs review` if confidence <0.5.
5. Non-UTF8 text PDF (Windows-1252) — re-decode rather than crashing.
6. PDF with two-column layout (text bleeds across columns) — parser should not concatenate left+right of a row into one merchant string.
7. Image > 10 MB or > 4096px — downscale before OCR or reject with size hint.
8. HEIC image from iPhone — Safari decodes natively; on Chrome desktop, show "convert to JPEG first".
9. Receipt photographed at angle (perspective distortion) — known degraded case; document the expected accuracy hit.
10. Receipt with thermal-paper fade (faint top portion) — OCR drops header; parser must still salvage line items via fallback.

Data conflicts:
11. Same file uploaded twice (same hash) — second upload is rejected with "already imported on YYYY-MM-DD"; hash stored on `documents`.
12. Same item bought at Walmart and Costco on the same day — two `lineItems` rows, one canonical item, two stores in price history.
13. Mixed currencies in import (user changed currency mid-history) — display in current currency symbol; flag in Insights so user knows numbers aren't comparable.
14. Merchant rule conflict: user manually re-categorizes Walmart from Groceries to Household — new rule wins and re-categorizes existing transactions retroactively.
15. Item alias loop (A→B, B→A from a bad merge) — detect on write, refuse second alias.

Empty / extreme:
16. Zero docs — Inbox shows onboarding, Items/Statements/Insights all show empty states with hint text.
17. 1000+ line items in a single statement (Costco bulk run) — parser stays under 2 s; Items list virtualizes.
18. Single item with 100 purchases — sparkline still renders, x-axis adapts; min/max correct.
19. Item with 1 purchase — delta is em dash, sparkline is a single dot, not a flat line.
20. Statement with 1 transaction and a $0 total — accepted, not treated as parse failure.

Persistence:
21. Page refresh during OCR — IndexedDB write of source Blob completed before OCR starts, so refresh recovers the doc; OCR re-runs on retry.
22. IndexedDB quota exceeded (Safari ~50 MB hard cap) — pre-flight check before storing Blob; show "storage full" with link to clear old statements.
23. Export → import roundtrip — schemaVersion respected; older exports auto-migrate; newer exports refuse with a clear message.
24. Two tabs open at once — last-write-wins on settings; documents/lineItems use auto-increment so both tabs can write safely.

Mobile:
25. iOS Safari `<input type="file" accept="image/*,application/pdf">` — both camera capture and Files app should work; verify on iOS 16 and 17.
26. PWA standalone mode (added to home screen) — file picker still opens; status bar respects theme.
27. Notched phone — safe-area-inset-top/bottom respected; tab bar not under home indicator.
28. Pull-to-refresh disabled inside the app shell (interferes with drag-to-reorder).
29. Android Chrome share-target — not in scope v1, but must not break if a user shares into the PWA URL.

## Manual smoke checklist

After each deploy, on the dev's actual phone:

1. App loads cold within 3 s on 4G; service worker caches shell.
2. Inbox: drag-drop a known-good PDF; it lands in queue and finishes as `done`.
3. Inbox: snap a receipt photo via the camera button; OCR completes, line items appear.
4. Items: open list; current prices and deltas render; no `NaN` or `undefined` anywhere.
5. Items: tap an item with multi-purchase history; sparkline renders; min/max correct.
6. Statements: tap a PDF row; original PDF opens inline.
7. Statements: delete a statement; rows for it disappear from Items if it was the only purchase of an item.
8. Insights: at least 3 panels populated (biggest jumps, most-bought, top categories).
9. Settings: switch theme dark → light → dark; persists across hard reload.
10. Settings: change currency USD → INR; symbol updates everywhere.
11. Settings: export JSON; AirDrop to Mac; file is valid JSON and includes `schemaVersion`.
12. Settings: import that same JSON into a clean profile; all data round-trips.
13. Add to Home Screen → open from icon; verify standalone mode (no Safari chrome) and safe-area insets.
14. Airplane mode: open app; cached shell loads; uploading shows offline message; queue drains when back online.
15. Force-quit during a parse; relaunch; that doc is `interrupted`, not lost.
