/**
 * Locale dictionaries for the dsh-nocobase browser half. Registered with the
 * client locale service when available; the navigator-language fallback keeps
 * the components working without it.
 *
 * @module dsh-nocobase/client/locales
 */

export const zh = {
  'title': 'NocoBase 低代码平台',
  'description': 'NocoBase 实例地址与登录入口。实例由根 docker-compose 拉起，账号走 casdoor 登录；部署与对接见 plugins/dsh-nocobase/README。',
  'baseUrl': '实例地址',
  'baseUrlHint': '根 docker-compose 默认映射到 http://127.0.0.1:13000。',
  'overridden': '已覆盖',
  'reset': '重置',
  'save': '保存',
  'saving': '保存中…',
  'discard': '放弃修改',
  'saveFailed': '保存失败',
  'readOnly': '当前部署不接受写入（只读）。',
  'notExposed': '此部署未开放 nocobase 设置命名空间，无法在此修改。',
  'healthOk': '运行中',
  'healthDown': '不可达',
  'healthChecking': '检测中…',
  'healthRefresh': '刷新',
  'open': '打开 NocoBase',
  'tabTitle': 'NocoBase',
  'panelHint': '用 casdoor 账号登录（任一组织：acme / globex / dsh-ops）。管理员逃生通道见 README。',
} as const

export const en = {
  'title': 'NocoBase low-code platform',
  'description': 'NocoBase instance origin and login entry. The instance runs from the root docker-compose; sign-in goes through casdoor. See plugins/dsh-nocobase/README for deployment.',
  'baseUrl': 'Instance origin',
  'baseUrlHint': 'The root docker-compose maps it to http://127.0.0.1:13000.',
  'overridden': 'overridden',
  'reset': 'Reset',
  'save': 'Save',
  'saving': 'Saving…',
  'discard': 'Discard',
  'saveFailed': 'Save failed',
  'readOnly': 'This deployment does not accept writes (read-only).',
  'notExposed': 'The nocobase settings namespace is not served here, so it cannot be edited from this page.',
  'healthOk': 'healthy',
  'healthDown': 'unreachable',
  'healthChecking': 'checking…',
  'healthRefresh': 'Refresh',
  'open': 'Open NocoBase',
  'tabTitle': 'NocoBase',
  'panelHint': 'Sign in with your casdoor account (any org: acme / globex / dsh-ops). Admin escape hatch: see the README.',
} as const

export type NocobaseDict = Record<keyof typeof zh, string>

/**
 * Resolve the dictionary from the browser language.
 * @returns the zh dictionary for Chinese locales, en otherwise.
 */
export function dictionary(): NocobaseDict {
  return typeof navigator !== 'undefined' && navigator.language.startsWith('zh') ? zh : en
}
