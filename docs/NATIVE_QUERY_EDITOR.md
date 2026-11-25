# Native statement editor

MongoDB saved queries and aggregation query objects now open a normal Monaco code editor. The selected database comes from the query object's connection and database; collection names are part of the statement, not a mandatory form. New saved records retain their original statement as syntax=mongo-shell. Legacy JSON filter/projection/sort and aggregation pipeline objects convert to db.getCollection(...).find(...).sort(...) or .aggregate(...) on opening; they are not written back until explicitly saved.

The initial execution grammar accepts exactly one native expression, including:
- db.collection.find(filter, projection), findOne, countDocuments, aggregate
- .sort(), .skip(), .limit(), .project() on find
- insertOne/insertMany, createIndex/dropIndex through existing explicit write authorization and native confirmation
- db.getCollection("collection.name") or bracket notation
- common BSON constructors (ObjectId, NumberInt, NumberLong, NumberDecimal, ISODate, etc.), EJSON literal data, regex literals, strings, arrays and objects

The parser uses Acorn AST inspection only; no evaluation, process access, arbitrary JavaScript, scripts with variables/loops, multiple statements, cross-database access or unsupported update/delete methods are offered. Execution delegates to existing MongoDB operations and their independent policy enforcement. Use typed BSON constructors for exact large numbers. Explicit cursor limits survive pagination. Query history uses script records and is not confused with old aggregation-only records.

Formatting uses Prettier for MongoDB source and sql-formatter for MySQL/MariaDB/SQLite/ClickHouse. MongoDB formatting checks that a valid parsed operation remains identical, refusing a semantic change. Formatting never executes a statement. Completion offers known collection/view names, supported methods, cursor modifiers, BSON constructors, operators and fields learned from actual query results; no automatic data query is executed just to provide completion. SQL completion retains metadata/table suggestions and result fields. All formatter files are bundled locally.

This is a supported native syntax subset, not a general mongosh runtime. Full arbitrary-shell scripts and additional guarded write commands remain future work.
