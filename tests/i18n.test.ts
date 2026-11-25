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

test('object inspector metadata, DDL and palette labels are localized', () => {
  for (const { locale } of languages) if (locale !== 'zh-CN') for (const key of ["对象详情","对象信息","数据类型配色","检查命令","展开面板","未选择对象","视图","表","集合","是","否","存储引擎","记录数（估算）","平均记录大小","数据大小","索引的总大小","空闲空间","自增值","排序规则","行格式","创建时间","更新时间","文档数","已固定","对象的平均大小","存储大小","索引数","元素数量","内存占用","内部编码","复制语句","导出语句","部分元数据不可用或无读取权限。","DDL 不可用或超出读取上限。","部分索引无法完整生成，请核对索引列表。","Redis 没有 DDL；以下是只读 Key 检查命令，不是数据备份。","字段数","语句已导出"]) assert.ok(Object.hasOwn(catalogs[locale], key), locale + ': ' + key)
})

test('visual browsing and page controls are localized', () => {
  for (const { locale } of languages) if (locale !== 'zh-CN') for (const key of ["筛选","添加筛选条件","添加条件组","组间关系","组内关系","条件组","点击 + 添加筛选条件","比较方式","等于","不等于","大于","大于或等于","小于","小于或等于","包含","为 NULL","不为 NULL","字段存在","字段缺失","排序方式","添加排序条件","点击 + 添加排序条件","排序字段","升序","降序","应用筛选与排序","重置筛选","创建工具","文本","首页","上一页","下一页","末页","页码","表格视图","记录视图","文本视图","记录","上一条记录","下一条记录","INVALID_FILTER: 筛选或排序条件无效","记录数超出末页跳转上限，请缩小筛选范围。","上一批","首批"]) assert.ok(Object.hasOwn(catalogs[locale], key), locale + ': ' + key)
})

test('advanced visual filter and suggested value controls are localized', () => {
  for (const { locale } of languages) if (locale !== 'zh-CN') for (const key of ["不包含","开头是","开头不是","结尾是","结尾不是","是空的","是非空的","在列表","不在列表","是字段类型","不是字段类型","字段类型","自定义条件","启用条件","下一条件关系","上移条件","下移条件","编辑筛选值","建议值","来自当前查询页","暂无建议值","搜索建议值","空字符串","列表使用 JSON 字符串数组，可勾选同类型建议值。"]) assert.ok(Object.hasOwn(catalogs[locale], key), locale + ': ' + key)
})

test('friendly MongoDB value types are localized', () => {
  for (const {locale} of languages) if(locale!=='zh-CN') for(const key of ["文本","数字","日期时间","对象 ID","自定义","自定义支持 BSON 构造语法，不执行 JavaScript。","请输入 UTC 日期时间。","当前实际类型"]) assert.ok(Object.hasOwn(catalogs[locale],key),locale+': '+key)
})

test('MongoDB object tree and saved object editors are localized', () => { for (const {locale} of languages) if (locale !== 'zh-CN') for (const key of ["函数","聚合管道","GridFS 存储桶","只读对象","GridFS 文件元数据浏览；暂不支持文件上传、下载和删除。","仅查看已存储的函数，不执行服务器端 JavaScript。","已保存对象","目标集合或视图","请选择目标集合或视图。","名称","保存成功","操作失败"]) assert.ok(Object.hasOwn(catalogs[locale],key),locale+': '+key) })

test('database context menu and database administration dialogs are localized',()=>{ for (const {locale} of languages) if(locale!=='zh-CN')for(const key of ["新建数据库","删除数据库","关闭数据库","数据库菜单","新建查询","查找数据库对象","导入数据","导出数据","导出结构脚本","初始集合","MongoDB 需要创建至少一个集合才能持久化数据库。","删除数据库会永久移除其中的全部数据及对象。","输入数据库名称以确认删除","仅查找可见对象名称，不扫描记录内容。","完整导出限单个对象 500 条及现有读取大小上限，超限时不会保存不完整文件。","导出选中对象的结构语句，不包含数据，也不会执行语句。","数据库名称已存在","数据库已创建","数据库已删除","导入完成","导出完成","数值超出安全范围，请使用 Extended JSON","对象数据超出完整导出上限，请使用分页导出或专用数据库工具。","INVALID_DATABASE: 数据库名称无效","PROTECTED_DATABASE: 不允许新建或删除系统数据库","INVALID_DATABASE: 初始集合名称无效","确认永久删除整个数据库？","选择数据文件","格式","新建","目标表或视图"])assert.ok(Object.hasOwn(catalogs[locale],key),locale+': '+key) })

test('unified preferences labels are localized',()=>{for(const {locale} of languages)if(locale!=='zh-CN')for(const key of ["偏好设置","常规","选项卡","代码补全","编辑器","自动恢复","外部工具","高级","关键字","注释","字符串","背景","外观","主题","启动画面","重新打开上次连接","始终显示选项卡栏","仅恢复上次保存的连接，不会自动执行查询或启用写入。","使用代码补全","输入时自动显示建议","优先选择第一个建议","代码补全使用当前编辑器和已读取的字段信息，不额外扫描数据库。","高亮与补全大小限制","显示行号","使用代码折叠","括号高亮","语法高亮","文本布局","Tab 插入空格","制表符宽度","自动换行","字体","默认字体","字号","语法颜色","自定义语法颜色","默认每页记录数","行高","自动","行底纹","每两行","每三行","保存查询历史","每页数量适用于新打开的数据对象；现有读取上限和写入确认保持不变。","自动保存已修改的查询","每 {0} 秒","草稿在本机加密保存，仅恢复编辑内容，不自动运行查询。临时连接不保存草稿。","可执行文件","选择可执行文件","文件可用","文件不可用","配置工具绝对路径并检查文件权限；工具执行及完整备份恢复尚未接入。","诊断日志","启用诊断日志","打开日志目录","日志只记录操作类别、耗时及成功状态，不记录连接地址、查询内容或凭据。","本地数据","所有设置保存在本机，不需要账户或云服务。","还原默认值","发现未恢复的查询草稿","恢复草稿","放弃草稿","读取恢复草稿失败","保存恢复草稿失败","INVALID_TOOL_PATH: 请输入可执行文件的绝对路径","INVALID_RECOVERY: 查询草稿参数无效","无法打开日志目录"])assert.ok(Object.hasOwn(catalogs[locale],key),locale+': '+key)})
