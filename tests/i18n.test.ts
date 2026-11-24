import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveLocale, translate, localizeMessage, isLanguagePreference } from '../src/shared/i18n'
import { en } from '../src/shared/i18n/catalog-en'
test('system language selects Chinese or English, explicit preference takes priority', () => {
  assert.equal(resolveLocale('system', 'zh-Hans-CN'), 'zh-CN')
  assert.equal(resolveLocale('system', 'zh-TW'), 'zh-CN')
  assert.equal(resolveLocale('system', 'ja-JP'), 'en')
  assert.equal(resolveLocale('en', 'zh-CN'), 'en')
  assert.equal(isLanguagePreference('unknown'), false)
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
