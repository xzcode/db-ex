import { boundedText, resourceName } from './common'

interface Token { value: string; kind: 'word' | 'quoted' | 'string' | 'symbol'; depth: number; start: number }
export interface SqlPolicy { sql: string; mode: 'read' | 'write'; select: boolean; ddl: boolean }

// This deliberately supports a conservative subset, not a general SQL parser.
// Database READ ONLY transactions remain the server-side barrier for read queries.
const SAFE_FUNCTIONS = new Set(`ABS ACOS ASIN ATAN ATAN2 CEIL CEILING COS COT DEGREES DIV EXP FLOOR LN LOG LOG10 LOG2 MOD PI POW POWER RADIANS RAND ROUND SIGN SIN SQRT TAN TRUNCATE
ASCII BIN BIT_LENGTH CHAR_LENGTH CHARACTER_LENGTH CONCAT CONCAT_WS ELT EXPORT_SET FIELD FIND_IN_SET FORMAT FROM_BASE64 HEX INSERT INSTR LCASE LEFT LENGTH LOCATE LOWER LPAD LTRIM MID OCT OCTET_LENGTH ORD POSITION QUOTE REPEAT REPLACE REVERSE RIGHT RPAD RTRIM SOUNDEX SPACE STRCMP SUBSTR SUBSTRING SUBSTRING_INDEX TO_BASE64 TRIM UCASE UNHEX UPPER
ADDDATE ADDTIME CONVERT_TZ CURDATE CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURTIME DATE DATEDIFF DATE_ADD DATE_FORMAT DATE_SUB DAY DAYNAME DAYOFMONTH DAYOFWEEK DAYOFYEAR EXTRACT FROM_DAYS FROM_UNIXTIME GET_FORMAT HOUR LAST_DAY LOCALTIME LOCALTIMESTAMP MAKEDATE MAKETIME MICROSECOND MINUTE MONTH MONTHNAME NOW PERIOD_ADD PERIOD_DIFF QUARTER SEC_TO_TIME SECOND STR_TO_DATE SUBDATE SUBTIME SYSDATE TIME TIMEDIFF TIMESTAMP TIMESTAMPADD TIMESTAMPDIFF TIME_FORMAT TIME_TO_SEC TO_DAYS TO_SECONDS UNIX_TIMESTAMP UTC_DATE UTC_TIME UTC_TIMESTAMP WEEK WEEKDAY WEEKOFYEAR YEAR YEARWEEK
AVG BIT_AND BIT_OR BIT_XOR COUNT GROUP_CONCAT JSON_ARRAYAGG JSON_OBJECTAGG MAX MIN STD STDDEV STDDEV_POP STDDEV_SAMP SUM VAR_POP VAR_SAMP VARIANCE
CAST CONVERT COALESCE GREATEST IF IFNULL ISNULL LEAST NULLIF IS_UUID UUID UUID_TO_BIN BIN_TO_UUID DATABASE SCHEMA VERSION CONNECTION_ID CURRENT_USER SESSION_USER SYSTEM_USER USER CHARSET COLLATION COERCIBILITY
JSON_ARRAY JSON_OBJECT JSON_QUOTE JSON_CONTAINS JSON_CONTAINS_PATH JSON_EXTRACT JSON_KEYS JSON_OVERLAPS JSON_SEARCH JSON_VALUE JSON_DEPTH JSON_LENGTH JSON_TYPE JSON_VALID JSON_PRETTY JSON_UNQUOTE JSON_SET JSON_INSERT JSON_REPLACE JSON_REMOVE JSON_MERGE_PATCH JSON_MERGE_PRESERVE JSON_ARRAY_APPEND JSON_ARRAY_INSERT JSON_STORAGE_SIZE JSON_STORAGE_FREE
ROW_NUMBER RANK DENSE_RANK PERCENT_RANK CUME_DIST NTILE LAG LEAD FIRST_VALUE LAST_VALUE NTH_VALUE
MD5 SHA SHA1 SHA2 CRC32 COMPRESS UNCOMPRESS UNCOMPRESSED_LENGTH INET_ATON INET_NTOA INET6_ATON INET6_NTOA IS_IPV4 IS_IPV6 IS_IPV4_COMPAT IS_IPV4_MAPPED`.split(/\s+/))
const PAREN_KEYWORDS = new Set(['AS', 'IN', 'EXISTS', 'NOT', 'AND', 'OR', 'XOR', 'OVER', 'PARTITION', 'BY', 'SELECT', 'FROM', 'WHERE', 'ON', 'HAVING', 'CASE', 'WHEN', 'THEN', 'ELSE', 'DISTINCT', 'ALL', 'ANY', 'SOME', 'UNION', 'INTERSECT', 'EXCEPT'])
const READ_FORBIDDEN = new Set(['INTO', 'OUTFILE', 'DUMPFILE', 'PROCEDURE', 'FOR', 'LOCK', 'UNLOCK', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'LOAD', 'CREATE', 'ALTER', 'DROP', 'GRANT', 'REVOKE', 'CALL', 'DO', 'HANDLER', 'EXECUTE', 'PREPARE', 'DEALLOCATE', 'SET', 'USE', 'XA', 'START', 'COMMIT', 'ROLLBACK'])
const SESSION_FORBIDDEN = new Set(['SET', 'USE', 'BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'XA', 'LOCK', 'UNLOCK', 'PREPARE', 'EXECUTE', 'DEALLOCATE', 'CALL', 'DO', 'HANDLER', 'LOAD', 'GRANT', 'REVOKE', 'INSTALL', 'UNINSTALL', 'KILL', 'SHUTDOWN', 'FLUSH', 'RESET', 'PURGE', 'CHANGE', 'STOP'])

function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  let depth = 0
  for (let i = 0; i < sql.length;) {
    const start = i
    const c = sql[i]
    if (/\s/.test(c)) { i++; continue }
    if (c === '\0') throw new Error('SQL_POLICY: SQL 不得包含 NUL')
    if (c === '/' && sql[i + 1] === '*') {
      if (['!', '+'].includes(sql[i + 2]) || /m!/i.test(sql.slice(i + 2, i + 4))) {
        throw new Error('SQL_POLICY: 不接受可执行注释或优化器提示')
      }
      const end = sql.indexOf('*/', i + 2)
      if (end < 0) throw new Error('SQL_POLICY: SQL 注释未闭合')
      i = end + 2; continue
    }
    if (c === '#' || (c === '-' && sql[i + 1] === '-' && /\s/.test(sql[i + 2] ?? ' '))) {
      const end = sql.indexOf('\n', i)
      i = end < 0 ? sql.length : end + 1; continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      let value = ''
      let closed = false
      i++
      while (i < sql.length) {
        if (sql[i] === '\\') throw new Error('SQL_POLICY: SQL 字面量请用双引号字符转义或参数绑定，避免 sql_mode 转义歧义')
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { value += quote; i += 2; continue }
          i++; closed = true; break
        }
        value += sql[i++]
      }
      if (!closed) throw new Error('SQL_POLICY: SQL 引号未闭合')
      tokens.push({ value: value.toUpperCase(), kind: quote === '`' ? 'quoted' : 'string', depth, start })
      continue
    }
    // MySQL identifiers may start with a digit or contain non-ASCII characters.
    // Treat the entire identifier as one token so `123ABS()` / `éABS()` cannot
    // masquerade as the allowlisted builtin ABS().
    if (/[a-zA-Z0-9_$\u0080-\uffff]/.test(c)) {
      i++
      while (i < sql.length && /[a-zA-Z0-9_$\u0080-\uffff]/.test(sql[i])) i++
      tokens.push({ value: sql.slice(start, i).toUpperCase(), kind: 'word', depth, start }); continue
    }
    if (c === '(') { tokens.push({ value: c, kind: 'symbol', depth, start }); depth++; i++; continue }
    if (c === ')') { depth--; if (depth < 0) throw new Error('SQL_POLICY: SQL 括号不匹配'); tokens.push({ value: c, kind: 'symbol', depth, start }); i++; continue }
    tokens.push({ value: c, kind: 'symbol', depth, start }); i++
  }
  if (depth !== 0) throw new Error('SQL_POLICY: SQL 括号不匹配')
  return tokens
}

export function quoteIdentifier(value: string): string {
  return `\`${resourceName(value).replaceAll('`', '``')}\``
}

export function inspectSql(input: unknown, writable: boolean): SqlPolicy {
  let sql = boundedText(input, 'SQL', 128 * 1024).trim()
  if (!sql) throw new Error('SQL_POLICY: SQL 不能为空')
  let tokens = tokenize(sql)
  const semicolons = tokens.filter(token => token.value === ';' && token.kind === 'symbol')
  if (semicolons.length > 1 || (semicolons.length === 1 && tokens.at(-1)?.value !== ';')) {
    throw new Error('SQL_POLICY: 每次只允许执行一条语句')
  }
  if (semicolons.length) {
    // Only a terminal separator is accepted; trailing comments are harmless.
    const separator = semicolons[0].start
    sql = sql.slice(0, separator).trim()
    tokens = tokenize(sql)
  }
  if (!tokens.length || tokens[0].kind !== 'word') throw new Error('SQL_POLICY: 不支持该 SQL 语句')
  const first = tokens[0].value
  if (SESSION_FORBIDDEN.has(first)) throw new Error('SQL_POLICY: 请使用事务按钮；不支持会话、管理或存储过程命令')
  const isSelect = first === 'SELECT' || first === 'WITH'
  const isRead = isSelect || ['SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'].includes(first)
  if (!isRead && !['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'].includes(first)) {
    throw new Error('SQL_POLICY: 支持 SELECT、SHOW、EXPLAIN 及明确授权的单条 DML/DDL')
  }
  if (tokens.some(token => token.kind === 'symbol' && token.value === '@')) throw new Error('SQL_POLICY: 不接受会话变量')
  if (isRead) {
    const prohibited = tokens.find((token, index) => token.kind === 'word' && READ_FORBIDDEN.has(token.value) &&
      !(tokens[index + 1]?.value === '(' && SAFE_FUNCTIONS.has(token.value)) &&
      !(first === 'SHOW' && index === 1 && token.value === 'CREATE'))
    if (prohibited) throw new Error('SQL_POLICY: 读取语句中包含写入或锁定能力')
    if (first === 'EXPLAIN' && tokens.some(token => token.kind === 'word' && token.value === 'ANALYZE')) {
      throw new Error('SQL_POLICY: EXPLAIN ANALYZE 会实际执行语句，请使用普通 EXPLAIN')
    }
    for (let i = 0; i < tokens.length - 1; i++) {
      const token = tokens[i]
      if (tokens[i + 1].value !== '(' || !['word', 'quoted', 'string'].includes(token.kind)) continue
      if (token.kind !== 'word' || tokens[i - 1]?.value === '.' || (!SAFE_FUNCTIONS.has(token.value) && !PAREN_KEYWORDS.has(token.value))) {
        throw new Error('SQL_POLICY: 读取模式仅允许内建纯查询函数；不执行自定义/存储函数')
      }
    }
  } else {
    if (!writable) throw new Error('READ_ONLY: 请先启用当前会话的写入权限')
    if (tokens.some(token => token.kind === 'word' && ['TRIGGER', 'PROCEDURE', 'FUNCTION', 'EVENT', 'USER', 'SERVER', 'TABLESPACE', 'OUTFILE', 'DUMPFILE'].includes(token.value))) {
      throw new Error('SQL_POLICY: 不支持程序、账户、文件和服务器管理语句')
    }
  }
  return { sql, mode: isRead ? 'read' : 'write', select: isSelect, ddl: ['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'].includes(first) }
}
