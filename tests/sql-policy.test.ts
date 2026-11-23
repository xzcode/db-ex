import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectSql, quoteIdentifier } from '../src/main/operations/sql-policy'

test('SQL lexer accepts one read statement and harmless text/comments', () => {
  for (const sql of [
    'SELECT id, name FROM users ORDER BY id',
    'SELECT COUNT(*), SUM(total), NOW() FROM orders',
    "SELECT '; DROP TABLE users', 'it''s valid'",
    '/* safe */ WITH users_cte AS (SELECT id FROM users) SELECT * FROM users_cte',
    'SELECT REPLACE(name, \'a\', \'b\') FROM users',
    'SHOW CREATE TABLE users',
  ]) assert.equal(inspectSql(sql, false).mode, 'read', sql)
  assert.equal(inspectSql("SELECT 1; -- comment contains ';'", false).sql, 'SELECT 1')
})

test('read protection rejects executable comments, SQL-mode ambiguity and statement stacking', () => {
  for (const sql of [
    'SELECT 1; DELETE FROM users', 'SELECT 1;;',
    'SELECT 1 /*!50000 INTO OUTFILE \'/tmp/data\' */',
    'SELECT /*M! DROP TABLE x */ 1', 'SELECT /*+ MAX_EXECUTION_TIME(0) */ 1',
    "SELECT 'ambiguous\\' literal'", 'SELECT 1 /* unfinished',
    'SELECT @@global.read_only', 'SELECT @a := 1',
  ]) assert.throws(() => inspectSql(sql, false), /SQL_POLICY/)
})

test('read protection blocks writes hidden in CTEs, functions, locks and EXPLAIN', () => {
  for (const sql of [
    'WITH c AS (SELECT 1) INSERT INTO users SELECT * FROM c',
    'WITH c AS (SELECT 1) DELETE FROM users',
    'SELECT custom_function()', 'SELECT db.custom_function()', 'SELECT `custom_function`()', 'SELECT 123ABS()', 'SELECT éABS()',
    'SELECT "db"."custom_function"()', 'SELECT SLEEP(10)', 'SELECT GET_LOCK(\'x\', 10)',
    'SELECT LOAD_FILE(\'/etc/passwd\')', 'SELECT 1 INTO OUTFILE \'/tmp/x\'',
    'SELECT * FROM users FOR UPDATE', 'EXPLAIN ANALYZE SELECT 1',
    'EXPLAIN DELETE FROM users', 'CALL procedure_name()',
  ]) assert.throws(() => inspectSql(sql, false), /SQL_POLICY/, sql)
})

test('write mode still rejects session and server administration commands', () => {
  assert.throws(() => inspectSql('DELETE FROM users', false), /READ_ONLY/)
  assert.equal(inspectSql('UPDATE users SET name = ?', true).mode, 'write')
  assert.equal(inspectSql('CREATE TABLE t (id INT)', true).ddl, true)
  for (const sql of ['COMMIT', 'SET autocommit = 1', 'START TRANSACTION', 'GRANT ALL ON *.* TO someone', 'CREATE FUNCTION f() RETURNS INT RETURN 1']) {
    assert.throws(() => inspectSql(sql, true), /SQL_POLICY/)
  }
})

test('identifiers are quoted without introducing raw SQL', () => {
  assert.equal(quoteIdentifier('table`name'), '`table``name`')
  assert.throws(() => quoteIdentifier('bad\0name'), /INVALID_INPUT/)
})
