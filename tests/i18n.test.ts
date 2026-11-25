import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveLocale, translate, localizeMessage, isLanguagePreference, isLocale, directionFor, languages, catalogs } from '../src/shared/i18n'
import { en } from '../src/shared/i18n/catalog-en'
test('system language maps national and regional locale variants, manual preference wins', () => {
  const variants: Record<string, string> = { 'zh-Hans-CN': 'zh-CN', 'zh-SG': 'zh-CN', 'zh-TW': 'zh-TW', 'zh-HK': 'zh-TW', 'zh-MO': 'zh-TW', 'zh-Hant-US': 'zh-TW', 'zh-Hans-TW': 'zh-CN', 'en-GB': 'en', 'ja-JP': 'ja', 'ko-KR': 'ko', 'de-AT': 'de', 'fr-CA': 'fr', 'es-MX': 'es', 'pt-PT': 'pt-BR', 'pt-BR': 'pt-BR', 'ru-RU': 'ru', 'it-IT': 'it', 'ar-SA': 'ar', 'hi-IN': 'hi', 'id-ID': 'id', 'in_ID': 'id', 'fi-FI': 'en', '': 'en' }
  for (const [system, expected] of Object.entries(variants)) assert.equal(resolveLocale('system', system), expected, system)
  assert.equal(resolveLocale('en', 'zh-CN'), 'en')
  assert.equal(resolveLocale('ja', 'de-DE'), 'ja')
  assert.equal(isLanguagePreference('unknown'), false)
  assert.equal(isLocale('system'), false)
  assert.equal(directionFor('ar'), 'rtl')
  assert.equal(directionFor('he' as never), 'ltr')
  assert.equal(languages.length, 14)
})
test('all supported locale catalogs cover the core UI and preserve placeholders and stable error codes', () => {
  const required = Object.keys(en).slice(0, Object.keys(en).indexOf('操作已完成') + 1).concat(['连接列表', '语言设置'])
  assert.equal(required.length, 325)
  for (const { locale } of languages) {
    if (locale === 'zh-CN') continue
    const catalog = catalogs[locale]
    for (const key of required) assert.ok(Object.hasOwn(catalog, key), locale + ': ' + key)
    for (const [key, value] of Object.entries(catalog)) {
      assert.ok(Object.hasOwn(en, key), locale + ': unknown key ' + key)
      assert.ok(value.trim(), locale + ': empty ' + key)
      assert.deepEqual([...key.matchAll(/\{\d+\}/g)].map(x => x[0]).sort(), [...value.matchAll(/\{\d+\}/g)].map(x => x[0]).sort(), locale + ': ' + key)
      const code = key.match(/^[A-Z][A-Z_]+: /)?.[0]
      if (code) assert.ok(value.startsWith(code), locale + ': ' + key)
    }
    assert.notEqual(translate(locale, '语言'), '语言', locale)
  }
  assert.equal(Object.keys(catalogs['zh-TW']).length, Object.keys(en).length)
  assert.equal(translate('de', 'SQL_POLICY: SQL 不得包含 NUL'), en['SQL_POLICY: SQL 不得包含 NUL'])
  assert.equal(translate('zh-CN', 'SQL_POLICY: SQL 不得包含 NUL'), 'SQL_POLICY: SQL 不得包含 NUL')
  assert.equal(localizeMessage('fr', '连接成功：mongodb · 10.0.0.1'), 'Connecté : mongodb · 10.0.0.1')
  assert.equal(localizeMessage('de', 'INVALID_CONNECTION: 请填写连接名称'), 'INVALID_CONNECTION: Verbindungsname eingeben.')
})
test('resource keys and parameters preserve data and fall back safely', () => {
  assert.equal(translate('en', '断开 {0}', ['My DB']), 'Disconnect My DB')
  assert.equal(translate('zh-CN', '断开 {0}', ['My DB']), '断开 My DB')
  assert.equal(translate('en', '未知资源'), '未知资源')
  assert.equal(translate('en', 'toString'), 'toString')
  assert.equal(translate('en', '断开 {0}', ['{1}']), 'Disconnect {1}')
  for (const [key, value] of Object.entries(en)) {
    assert.deepEqual([...key.matchAll(/\{\d+\}/g)].map(x => x[0]).sort(), [...value.matchAll(/\{\d+\}/g)].map(x => x[0]).sort(), key)
  }
})
test('app messages retain error codes, diagnostics and user-controlled values', () => {
  assert.equal(localizeMessage('en', '已导入 3 个连接配置'), 'Imported 3 connections')
  assert.equal(localizeMessage('en', "Error invoking remote method 'connections:save': Error: INVALID_CONNECTION: 请填写连接名称"), 'INVALID_CONNECTION: Enter Connection name.')
  assert.equal(localizeMessage('en', '连接成功：mongodb · 10.0.0.1'), 'Connected: mongodb · 10.0.0.1')
  assert.match(localizeMessage('en', 'SSH_HOST_KEY_UNTRUSTED: abc123。第 1 跳 example.test:22，请从可信渠道核对并填写指纹。'), /^SSH_HOST_KEY_UNTRUSTED: abc123.*example\.test:22/)
  assert.equal(localizeMessage('zh-CN', '连接成功'), '连接成功')
  assert.equal(localizeMessage('en', '未翻译的诊断'), '未翻译的诊断')
})

test('BSON appearance and expanded color picker controls have translations in every locale', () => {
  for (const { locale } of languages) if (locale !== 'zh-CN') for (const key of ['BSON 类型配色','BSON 数据类型','按类型着色','显示类型标记','缺失字段','未知类型','最近使用的颜色','恢复此类型默认颜色','恢复全部默认颜色','配色仅影响显示，不修改数据库数据。','查看文档','文档树','原始 EJSON','无法解析文档，请查看原始 EJSON。','部分类型或字段预览受限，完整内容请查看原始 EJSON。','预览','字段','字段值']) assert.ok(Object.hasOwn(catalogs[locale], key), locale + ': ' + key)
})

test('compact MongoDB grid summaries and controls are localized', () => {
  for (const { locale } of languages) if (locale !== 'zh-CN') for (const key of ['(Array) {0} 个元素','(Document) {0} 个字段','(Binary) {0} 字节','查询条件','调整列宽']) assert.ok(Object.hasOwn(catalogs[locale], key), locale + ': ' + key)
})

test('MongoDB document context and editor commands are localized in every language', () => {
  for (const { locale } of languages) if (locale !== 'zh-CN') for (const key of ["编辑文档","新增文档","删除文档","复制为新文档","复制字段值","复制完整文档","设为 NULL","设为空字符串","按此值筛选","编辑需要完整文档和写入权限。","BSON 文档语法","修改时必须保留 _id","未指定 _id 时自动生成","验证","更新","文档验证通过","已复制到剪贴板","文档包含无法安全编辑的 BSON 类型。","无法修改此字段。","BSON_EDITOR_INVALID: 文档语法或类型无效（第 {0} 行，第 {1} 列）","INVALID_DOCUMENT: 文档 BSON 类型无效","LIMIT_EXCEEDED: 剪贴板文本过大"]) assert.ok(Object.hasOwn(catalogs[locale], key), locale + ': ' + key)
})
