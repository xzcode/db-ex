# DB EX v0.5.7 (Preview)

- Shared right-side object inspector for MySQL, MongoDB and Redis: information, DDL/inspection commands, data type colors, expand/close/refresh.
- MySQL real server metadata and SHOW CREATE TABLE/VIEW; row counts identified as estimates. MongoDB collection options, statistics and index definitions; unsupported index reconstruction is disclosed. Redis key type, TTL, length, estimated memory usage, encoding, and read-only command preview (not DDL or backup).
- Copy/export definition text without executing it. Independent per-engine type colors, 36 presets and custom colors. Preserve existing BSON palettes, connection data and write safeguards.
- 14 UI languages; local preferences; native macOS ARM64, Windows x64 and Linux x64 packages.

- macOS icon uses a platform-specific inset opaque navy rounded-square tile in the legacy ICNS, preserving the approved database glyph and colors. This addresses the oversized icon shape that can trigger Tahoe's generated gray/white outer tile. Windows and Linux retain their previous artwork. Actual Dock appearance still depends on the OS rendering and icon cache.

- Visual AND/OR filter groups, typed BSON filters, multi-field sort, separate MongoDB text mode (Filter/Projection/Sort), and parameterized MySQL table browsing. A compact bottom toolbar provides record actions, query summary, first/previous/next/last page, page jump, page size and grid/record/text views. Last-page count is on demand and capped at 1,000,001; Redis retains cursor-based batches with first/previous/next navigation. Record saves/cancels continue in the reviewed edit dialog rather than unconfirmed inline writes.

- Complete visual filter comparison menu, condition checkboxes, mixed AND/OR per rule, reorder controls, list matching, MongoDB type predicates and safe custom predicates. Searchable typed suggested-value picker uses the current result page only, up to 100 unique typed values. MySQL supports applicable operators through bound parameters. Fix MongoDB metadata command options and provide partial statistics fallback.

- Simplify MongoDB filter value types to Text, Number, Date and time, Object ID and Custom. Numeric suggestions preserve their BSON type, manual numbers choose bounded numeric representations automatically, and Custom supports explicit BSON constructors. Fix a previous TypeScript error caused by calling the filter field handler on a sort rule.

- MongoDB filter inputs automatically recognize valid 24-character hexadecimal ObjectId text, preserve explicit type choices and actual suggested String values, and revert automatic detection when a value ceases to match. Detection works inline and in the value dialog without database access.

- Categorized MongoDB database explorer: collections, views, stored functions, per-collection indexes, deprecated MapReduce notice, locally saved aggregation pipelines, GridFS bucket metadata and saved queries. Existing data/index/inspection views are reused. Views and stored function/GridFS metadata are read-only; GridFS upload/download/delete and server object DDL editing are not included. Saved objects use encrypted local snippet storage and existing bounded read operations.

- MongoDB/MySQL database-level context menus: close browser selection, create database, protected confirmed database deletion, new query, object-name search, bounded selected-object import/export, structure script export, refresh. Native MongoDB Database Tools, arbitrary scripts, maintenance and reverse modeling remain future work; bounded export is not a full backup. Fix outdated replica integration assertion to use the collection category.

- Unified nine-tab preferences window (toolbar gear / Cmd or Ctrl+,): appearance, startup and tabs, completion, editor, records, per-engine type colors, encrypted query draft recovery, external tool paths and local diagnostics. Actual editor and grid settings are wired, with save/cancel/reset. External executable path configuration is not tool execution or a completed backup/restore system. Startup restores at most the last saved connection, not queries or write permissions. Fix TypeScript narrowing in database action dialogs.
