# Object workspace and column interactions

The workspace follows the supplied Navicat-style object-list and grid references, without copying proprietary artwork.

- The fixed Objects tab displays the selected database or MongoDB object category. The left resource tree remains available. Double-click or Enter opens a table, collection, view, or supported object; the Open toolbar action does the same.
- Object lists have name search and column-header ascending/descending sorting. Counts and byte sizes are compared as raw values (large integers use BigInt), not localized strings. Missing statistics sort last, never masquerading as zero.
- MySQL and MariaDB use bounded information_schema metadata (row counts are estimates). MongoDB uses bounded collStats requests, at most the first 50 collections and a 4.5-second statistics budget with three workers. Other objects retain their names even if metadata is unavailable. SQLite does not invent document counts or per-table storage sizes.
- Each connection supports up to 12 open object tabs; individual grids, query drafts, filters, and inspector state stay mounted while switching. The tooltip identifies object, database, and connection. Existing session-level write protection and transaction semantics remain unchanged. Within the same connection, tab navigation is gated while a database request is active. Different connections remain independent.
- The existing New Query action opens a dedicated query tab for the selected database. A MongoDB query or aggregation library remains a separate object tab. One standalone SQL query tab per database is reused in this first implementation. Restart restoration continues to restore the selected object/editor, not the entire set of open tabs.
- The redundant database engine label is removed from the workbench header. Object names and write-access indicators remain.
- On table/collection data grids, selecting a column or using its ellipsis/context menu offers ascending sort, descending sort, remove all sorting and add filter. Sort operations run the server-side browse query, preserving the applied filter/projection and resetting to the first page. Multiple sort fields retain their priority. Add Filter opens a draft for the chosen field without automatically executing it. Existing column resize and row/document actions remain available.
- Query/aggregation results and Redis cursor scans are not presented as globally sortable table data, since they require different query semantics.

Local targeted UI, sort helper and localization checks are recorded in the PR. The full integrated CI and native desktop checks are still required before the v0.6.0 release.
