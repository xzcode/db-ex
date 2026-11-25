# DB EX v0.5.7 (Preview)

- Shared right-side object inspector for MySQL, MongoDB and Redis: information, DDL/inspection commands, data type colors, expand/close/refresh.
- MySQL real server metadata and SHOW CREATE TABLE/VIEW; row counts identified as estimates. MongoDB collection options, statistics and index definitions; unsupported index reconstruction is disclosed. Redis key type, TTL, length, estimated memory usage, encoding, and read-only command preview (not DDL or backup).
- Copy/export definition text without executing it. Independent per-engine type colors, 36 presets and custom colors. Preserve existing BSON palettes, connection data and write safeguards.
- 14 UI languages; local preferences; native macOS ARM64, Windows x64 and Linux x64 packages.

- macOS icon uses a platform-specific inset opaque navy rounded-square tile in the legacy ICNS, preserving the approved database glyph and colors. This addresses the oversized icon shape that can trigger Tahoe's generated gray/white outer tile. Windows and Linux retain their previous artwork. Actual Dock appearance still depends on the OS rendering and icon cache.

- Visual AND/OR filter groups, typed BSON filters, multi-field sort, separate MongoDB text mode (Filter/Projection/Sort), and parameterized MySQL table browsing. A compact bottom toolbar provides record actions, query summary, first/previous/next/last page, page jump, page size and grid/record/text views. Last-page count is on demand and capped at 1,000,001; Redis retains cursor-based batches with first/previous/next navigation. Record saves/cancels continue in the reviewed edit dialog rather than unconfirmed inline writes.
