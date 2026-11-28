# Query workspace refinement

## Scope

Based on the supplied Navicat screenshots and the Navicat online manual's query editor, code completion and result handling descriptions. DB EX keeps its own UI and its typed execution policy.

- Saved SQL and MongoDB query editors share a draggable, keyboard-accessible split. Bottom/right/editor-only/result-only layouts are available; split proportions persist locally. The run bar displays the bound connection/database. Saved-query scope does not silently change.
- Results have message, summary, current result and up to five in-memory pinned snapshot tabs. A snapshot is immutable and has no write or paging actions. Result grid columns can resize. Grid, BSON document tree and JSON views, record/cell inspection, type colors, copy, current-page CSV and canonical MongoDB EJSON export are supported. CSV contains displayed columns. SQL engines without exact raw rows export available preview values.
- MongoDB method overloads, snippets, argument hints, collection/field suggestions and more operator vocabulary. Supported find options: sort, skip, limit, hint, collation, batchSize, maxTimeMS. The compiler additionally maps count, estimatedDocumentCount, getIndexes, cursor hint/collation/batchSize/maxTimeMS/pretty/toArray and typed updateOne/updateMany/replaceOne/deleteOne/deleteMany/findOneAndUpdate/findOneAndReplace/findOneAndDelete. Reference-only methods are labeled, not executable.
- Mutation execution still requires explicit write authorization and confirmation. Nonempty filters and strict supported options/operators are required; arbitrary JavaScript is not executed. Whole-document edits are limited to ordinary collections and complete unprojected find results with _id; writes compare the original document. Projected, aggregated and pinned results are not editable. Paging/refresh are bound to the actual applied operation, not the modified editor buffer. Refresh never repeats a write. Byte-limited Mongo find pages advance by actual returned rows; oversized individual documents remain explicitly truncated.
- Boundaries: single-statement execution, bounded preview; pins are not durable or server cursors. No arbitrary mongosh runtime, SQL result-set direct writes, cross-connection retargeting, multi-statement/multi-result execution, independent pop-out result window, or global replacement of legacy Redis/aggregation views in this batch.

## Validation

Local typecheck passed; 21 focused parser, policy, completion, export and locale checks passed; four Playwright cases passed (including existing Mongo/SQL saved-query cases and actual divider dragging, layout switching, function signatures, pin preservation, EJSON export, paging and edit restrictions). New isolated MongoDB integration case added for actual query options, confirmation and native write methods. Real database execution and packaged desktop compatibility require CI on the final candidate.
