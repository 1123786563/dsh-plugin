/**
 * Locale dictionaries for the openmeter client half (zh primary, en
 * fallback; navigator-language pick when the shell locale service is absent).
 *
 * @module dsh-openmeter/client/locales
 */

/** zh-CN dictionary. */
export const zh: Record<string, string> = {
  'nav.title': '计费',
  'card.title': 'OpenMeter 计费',
  'card.description': '把每次模型调用的用量上报到自托管 OpenMeter：余额不足自动阻断（故障放行），价格取自 llm-cost 价格库。',
  'card.notExposed': '设置命名空间未暴露给当前客户端。',
  'card.readOnly': '当前文档不可写，卡片仅展示。',
  'card.saveFailed': '保存失败',
  'card.save': '保存',
  'card.saving': '保存中…',
  'card.discard': '放弃',
  'field.endpoint': 'API 地址',
  'field.token': 'Bearer Token（可选）',
  'field.houseSubject': '内部户 Subject',
  'field.featureKey': '门禁 Feature Key',
  'field.eventType': 'CloudEvents 事件类型',
  'field.meterSlug': 'Meter Slug',
  'field.quoteCurrency': '报价币种',
  'field.accessCacheTtlMs': '门禁缓存 TTL（毫秒）',
  'field.priceRefreshMs': '价格刷新间隔（毫秒）',
  'field.batchSize': '摄入批量',
  'field.blockEnabled': '余额耗尽硬阻断',
  'panel.refresh': '刷新',
  'panel.usage': '用量',
  'panel.cashier': '收银台',
  'panel.settings': '设置',
  'panel.today': '本月累计（按客户）',
  'panel.recent': '最近调用',
  'panel.unpriced': '未定价',
  'panel.subject': '客户',
  'panel.model': '模型',
  'panel.tokens': 'Tokens',
  'panel.amount': '估算金额',
  'panel.time': '时间',
  'panel.customers': '客户与余额',
  'panel.newCustomer': '新建客户',
  'panel.customerKey': '客户 Key',
  'panel.customerName': '客户名称',
  'panel.create': '创建',
  'panel.recharge': '充值',
  'panel.amountPrompt': '金额（token 额度）',
  'panel.block': '阻断',
  'panel.unblock': '解封',
  'panel.bindings': '预设 → 客户映射',
  'panel.preset': 'Agent 预设',
  'panel.customer': '客户',
  'panel.bind': '绑定',
  'panel.unbind': '解绑',
  'panel.house': '（内部户，不阻断）',
  'panel.balance': '余额',
  'panel.noEntitlement': '未初始化',
  'panel.blocked': '已手动阻断',
  'panel.wal': '待上报事件',
  'panel.statusError': '状态不可用',
  'panel.loadError': '加载失败',
}

/** en dictionary. */
export const en: Record<string, string> = {
  'nav.title': 'Billing',
  'card.title': 'OpenMeter Billing',
  'card.description': 'Meter every model call into your self-hosted OpenMeter: hard-block on exhausted balance (fail-open), prices from the llm-cost catalog.',
  'card.notExposed': 'Settings namespace not exposed to this client.',
  'card.readOnly': 'Document is read-only; the card is display-only.',
  'card.saveFailed': 'Save failed',
  'card.save': 'Save',
  'card.saving': 'Saving…',
  'card.discard': 'Discard',
  'field.endpoint': 'API origin',
  'field.token': 'Bearer token (optional)',
  'field.houseSubject': 'House subject',
  'field.featureKey': 'Gate feature key',
  'field.eventType': 'CloudEvents event type',
  'field.meterSlug': 'Meter slug',
  'field.quoteCurrency': 'Quote currency',
  'field.accessCacheTtlMs': 'Gate cache TTL (ms)',
  'field.priceRefreshMs': 'Price refresh (ms)',
  'field.batchSize': 'Ingest batch size',
  'field.blockEnabled': 'Hard block on exhausted balance',
  'panel.refresh': 'Refresh',
  'panel.usage': 'Usage',
  'panel.cashier': 'Cashier',
  'panel.settings': 'Settings',
  'panel.today': 'Month to date (by customer)',
  'panel.recent': 'Recent calls',
  'panel.unpriced': 'unpriced',
  'panel.subject': 'Customer',
  'panel.model': 'Model',
  'panel.tokens': 'Tokens',
  'panel.amount': 'Est. amount',
  'panel.time': 'Time',
  'panel.customers': 'Customers & balances',
  'panel.newCustomer': 'New customer',
  'panel.customerKey': 'Customer key',
  'panel.customerName': 'Customer name',
  'panel.create': 'Create',
  'panel.recharge': 'Recharge',
  'panel.amountPrompt': 'Amount (token credit)',
  'panel.block': 'Block',
  'panel.unblock': 'Unblock',
  'panel.bindings': 'Preset → customer bindings',
  'panel.preset': 'Agent preset',
  'panel.customer': 'Customer',
  'panel.bind': 'Bind',
  'panel.unbind': 'Unbind',
  'panel.house': '(house, never blocked)',
  'panel.balance': 'Balance',
  'panel.noEntitlement': 'not initialized',
  'panel.blocked': 'manually blocked',
  'panel.wal': 'Pending events',
  'panel.statusError': 'Status unavailable',
  'panel.loadError': 'Load failed',
}

/** Pick a dictionary by navigator language. */
export function dictionary(): Record<string, string> {
  const language = typeof navigator !== 'undefined' && navigator.language !== undefined ? navigator.language : 'zh'
  return language.toLowerCase().startsWith('zh') ? zh : en
}

/**
 * Interpolate {params} into a template.
 * @param template - the template string.
 * @param params - substitution values.
 */
export function format(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? `{${key}}`))
}
