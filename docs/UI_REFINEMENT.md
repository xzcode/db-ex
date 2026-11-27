# Desktop UI refinement — object catalog and themes

Scope: standalone refinement based on the published v1.0.0, independent of
the unfinished M12 migration work. Do not renumber M13 data synchronization.

## User feedback and implementation

1. Labels in table headers, tab bars, resource-tree buttons and menus are
   not selectable text. Actual row values and code editors remain copyable.
   Column sorting/edit selection still works; the active column header uses
   a subtle underline instead of a filled selection block.
2. Default the inspector to open. A dedicated versioned local preference
   stores open/closed, info/DDL/colors tab, expanded mode and width. All
   supported object workbenches and catalogs read the same reactive state;
   storage events update other workspace windows. Resize by dragging the
   separator or using its keyboard controls. Closing the panel is a global
   choice rather than a per-tab override.
3. Select a table, collection or view in a catalog without opening a data tab.
   Its inspector executes only the supported read-only metadata action.
   A short debounce and the existing per-session operation guard prevent
   competing requests; stale responses cannot overwrite another selection.
   Double-click still opens the data tab. In the tree, right-click Info/DDL
   opens a catalog preview without opening data. Do not misrepresent one
   GridFS backing collection as a complete bucket definition.
4. Catalog column widths have a dedicated validated local store by engine and
   catalog kind. Drag, keyboard resize, double-click auto-fit and horizontal
   scrolling are supported. Existing numeric sorting stays numeric.
5. The tree and middle catalog share one object-type menu registry. Real
   actions only: open, structure/indexes, object info/DDL, copy name, copy
   qualified name, targeted import/export/script, refresh and available
   native tools. Category menus reflect collections, views, functions,
   indexes, pipelines, GridFS and queries. Query folders retain their actual
   query mode; saved queries have copy/rename/delete/import/export actions
   through existing persistence APIs. Index category can choose a collection
   and open the index manager. No fake BI/model designer or executable
   server-side JS functions.
6. MongoDB ordinary collection maintenance adds typed main-process actions
   for create, rename, empty and drop. Require a writable session and native
   confirmation; destructive dialogs require the exact collection name.
   Protect system databases/namespaces, capped/time-series/clustered
   collections and GridFS backing names; rename never drops the destination.
   Clearing retains indexes. Existing queries are not rewritten. Dirty
   object tabs must be saved/closed first. Collection changes refresh the
   relevant catalog and invalidate affected object tabs.
7. Collection-specific MongoDump/Restore/Import/Export dialogs preselect and
   lock the collection. Dump uses an explicit --collection; restore uses an
   exact --nsInclude, not a database-wide wildcard, and rejects wildcard or
   escape characters. Restore is append/restore, never --drop. Native tool
   availability and existing verified-network restrictions still apply.
8. Add gray, pure black and soft white themes alongside existing system/light/
   dark. Semantic surfaces differentiate the application, sidebar, toolbar,
   tab bar, content, column header, inspector, menu and editor. Monaco follows
   the chosen palette unless the user explicitly configures syntax colors.
   All fourteen languages expose the new theme choices. Detailed new menu
   and diagnostic text is fully provided in English, simplified and
   traditional Chinese, with existing English fallback for other languages.

## Verification

- Local isolated MongoDB 8.0.12 real test confirmed create/rename/empty/drop,
  index retention, same-name collision rejection, read-only/confirmation
  rejection, protected database and capped/GridFS restrictions.
- Focused policy/i18n/native-tools/preferences tests: 26 passed.
- Initial complete browser suite was interrupted by local resource pressure
  after 31 passing cases; do not claim a full pass based on those results.
  All four additional browser regression cases passed in focused runs:
  global inspector/catalog preview, actual pointer drag and keyboard column
  resizing with persisted widths and shared object menu, category menus and
  explicit destructive confirmation, and three new themes. The final gray
  editor surface was separated from the content background and the affected
  resize/theme cases passed together (2/2).
- Final exact-commit integrated UI, database and packaged desktop CI are
  mandatory before merging or publishing a new version.

## Deliberate limitations

SQL-family table/view menus use existing supported structure and data
operations. Generic SQL table creation/rename/drop/truncate visual designers,
GridFS bucket writes, stored function execution, BI/modeling, automatic
collection cloning and full database migration are not silently implemented
via placeholder buttons. MongoDB/SQL metadata is permission-filtered; remote
read latency and server-side concurrent changes can affect inspection or
maintenance. Clearing MongoDB is not a multi-document atomic rollback
operation. This branch is not a replacement of v1.0.0 release artifacts.
