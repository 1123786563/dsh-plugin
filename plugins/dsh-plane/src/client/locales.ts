/**
 * Locale dictionaries for the plane browser half. Registered with the client
 * locale service when available; the navigator-language fallback keeps the
 * components working without it.
 *
 * @module dsh-plane/client/locales
 */

export const zh = {
  'title': 'Plane 项目管理',
  'description': 'Plane（makeplane）：local 后端在宿主进程内运行 Plane 兼容引擎（零外部服务），remote 后端连接 Plane Cloud 或自托管实例。',
  'backend': '后端',
  'backendHint': 'local：进程内引擎（默认，无需部署）；remote：连接远端 Plane 实例。',
  'backendLocal': 'local（进程内引擎）',
  'backendRemote': 'remote（远端实例）',
  'baseUrl': 'API 地址',
  'baseUrlHint': 'Plane Cloud 用 https://api.plane.so；自建实例填实例地址。',
  'apiKey': 'API Key（个人访问令牌）',
  'apiKeyHint': 'Plane: Profile Settings → Personal Access Tokens；保存后即时生效，无需重启。留空表示不修改。',
  'workspaceSlug': '默认工作区 slug',
  'workspaceSlugHint': 'Plane URL 中主机后的那段，如 my-team。',
  'defaultProjectId': '默认项目 id',
  'defaultProjectIdHint': '可选；工具与面板未显式指定项目时使用。',
  'dataDir': '数据目录',
  'dataDirHint': 'local 引擎的 store.json 所在目录；留空使用 $DSH_HOME/plane。改动重启后生效。',
  'perPage': '列表页大小',
  'perPageHint': '1–100，默认 50。',
  'overridden': '已覆盖',
  'reset': '重置',
  'invalidNumber': '必须是 1–100 的整数',
  'invalidBackend': '必须是 local 或 remote',
  'engineTitle': '本地引擎',
  'engineCounts': '{projects} 个项目 · {workItems} 个工作项 · {comments} 条评论',
  'engineKeyLabel': '引擎 API Key（外部工具连 /plugins/dsh-plane/api/v1 用）',
  'engineUnavailable': '引擎暂不可用',
  'save': '保存',
  'saving': '保存中…',
  'discard': '放弃修改',
  'saveFailed': '保存失败',
  'readOnly': '当前部署不接受写入（只读）。',
  'notExposed': '此部署未开放 plane 设置命名空间，无法在此修改。',
  'expand': '展开',
  'collapse': '收起',
  'tabTitle': 'Plane 面板',
  'panelNotConfigured': '尚未配置 API Key。在设置 → 插件 里填写 Plane 配置，或在 profile 的 cordis.patch.yml 里设置 apiKey。',
  'panelNoWorkspace': '尚未配置默认工作区 slug（设置 → 插件）。',
  'panelRefresh': '刷新',
  'panelLoading': '加载中…',
  'panelEmpty': '这个项目没有工作项。',
  'panelMore': '加载更多',
  'panelError': '请求失败',
  'panelRetry': '重试',
  'panelProjects': '项目',
  'panelIssuesCount': '{n} 个工作项',
  'panelCreatePlaceholder': '新建工作项标题…',
  'panelCreate': '新建',
  'panelCreating': '创建中…',
  'panelOpenBoard': '打开看板',
} as const

export const en = {
  'title': 'Plane project tracking',
  'description': 'Plane (makeplane): the local backend runs the Plane-compatible engine inside the harness process (no external service); remote talks to Plane Cloud or a self-hosted instance.',
  'backend': 'Backend',
  'backendHint': 'local: in-process engine (default, nothing to deploy); remote: a remote Plane instance.',
  'backendLocal': 'local (in-process engine)',
  'backendRemote': 'remote (remote instance)',
  'baseUrl': 'API base URL',
  'baseUrlHint': 'https://api.plane.so on Plane Cloud; your instance origin when self-hosted.',
  'apiKey': 'API key (personal access token)',
  'apiKeyHint': 'Plane: Profile Settings → Personal Access Tokens; takes effect immediately after save, no restart. Leave empty to keep unchanged.',
  'workspaceSlug': 'Default workspace slug',
  'workspaceSlugHint': 'The URL segment after the host, e.g. my-team.',
  'defaultProjectId': 'Default project id',
  'defaultProjectIdHint': 'Optional; used when a tool or the panel names no project.',
  'dataDir': 'Data directory',
  'dataDirHint': 'Where the local engine keeps store.json; empty uses $DSH_HOME/plane. Changes apply after a restart.',
  'perPage': 'List page size',
  'perPageHint': '1-100, default 50.',
  'overridden': 'overridden',
  'reset': 'Reset',
  'invalidNumber': 'Must be an integer in 1-100',
  'invalidBackend': 'Must be local or remote',
  'engineTitle': 'Local engine',
  'engineCounts': '{projects} projects · {workItems} work items · {comments} comments',
  'engineKeyLabel': 'Engine API key (for external tools hitting /plugins/dsh-plane/api/v1)',
  'engineUnavailable': 'Engine unavailable',
  'save': 'Save',
  'saving': 'Saving…',
  'discard': 'Discard',
  'saveFailed': 'Save failed',
  'readOnly': 'This deployment does not accept writes (read-only).',
  'notExposed': 'The plane settings namespace is not served here, so it cannot be edited from this page.',
  'expand': 'Expand',
  'collapse': 'Collapse',
  'tabTitle': 'Plane panel',
  'panelNotConfigured': 'No API key configured yet. Fill the Plane settings under Settings → Plugins, or set apiKey in the profile cordis.patch.yml.',
  'panelNoWorkspace': 'No default workspace slug configured (Settings → Plugins).',
  'panelRefresh': 'Refresh',
  'panelLoading': 'Loading…',
  'panelEmpty': 'No work items in this project.',
  'panelMore': 'Load more',
  'panelError': 'Request failed',
  'panelRetry': 'Retry',
  'panelProjects': 'Project',
  'panelIssuesCount': '{n} work items',
  'panelCreatePlaceholder': 'New work item title…',
  'panelCreate': 'Create',
  'panelCreating': 'Creating…',
  'panelOpenBoard': 'Open board',
} as const

export type PlaneDict = Record<keyof typeof zh, string>

/**
  * Resolve the dictionary from the browser language.
  * @returns the zh dictionary for Chinese locales, en otherwise.
  */
export function dictionary(): PlaneDict {
  return typeof navigator !== 'undefined' && navigator.language.startsWith('zh') ? zh : en
}

/**
  * Interpolate {name}-style parameters into localized copy.
  * @param template - copy carrying {name} placeholders.
  * @param params - placeholder values.
  * @returns the interpolated copy.
  */
export function format(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (_match, key: string) => String(params[key] ?? ''))
}