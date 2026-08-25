/**
 * Locale dictionaries for the job-search browser half. Registered with the
 * client locale service when available; the navigator-language fallback keeps
 * the components working without it.
 *
 * @module dsh-job-search/client/locales
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'jobSearch'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger': '求职看板',
  'panel.aria': '求职进度看板',
  'profile.present': '档案：{name}',
  'profile.absent': '尚未建立候选人档案（先运行 job_search_setup）',
  'jobs.count': '已抓取职位 {count} 个',
  'funnel.title': '投递漏斗',
  'funnel.drafted': '草稿 {count}',
  'funnel.applied': '已投递 {count}',
  'funnel.interview': '面试 {count}',
  'funnel.offer': '录用 {count}',
  'funnel.rejected': '被拒 {count}',
  'funnel.withdrawn': '撤回 {count}',
  'jobs.title': '最近职位',
  'applications.title': '最近投递',
  'applications.empty': '还没有投递记录',
  'jobs.empty': '还没有抓取到职位（先运行 job_search_scrape）',
  'status.loading': '加载中…',
  'status.error': '加载失败：{message}',
  'action.refresh': '刷新',
  'job.url': '打开职位链接',
  'appstatus.drafted': '草稿',
  'appstatus.applied': '已投递',
  'appstatus.interview': '面试',
  'appstatus.offer': '录用',
  'appstatus.rejected': '被拒',
  'appstatus.withdrawn': '撤回',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<keyof typeof zh, string> = {
  'trigger': 'Job pipeline',
  'panel.aria': 'Job search pipeline dashboard',
  'profile.present': 'Profile: {name}',
  'profile.absent': 'No candidate profile yet (run job_search_setup first)',
  'jobs.count': '{count} scraped job(s)',
  'funnel.title': 'Application funnel',
  'funnel.drafted': 'drafted {count}',
  'funnel.applied': 'applied {count}',
  'funnel.interview': 'interview {count}',
  'funnel.offer': 'offer {count}',
  'funnel.rejected': 'rejected {count}',
  'funnel.withdrawn': 'withdrawn {count}',
  'jobs.title': 'Recent jobs',
  'applications.title': 'Recent applications',
  'applications.empty': 'No applications yet',
  'jobs.empty': 'No scraped jobs yet (run job_search_scrape first)',
  'status.loading': 'Loading…',
  'status.error': 'Failed to load: {message}',
  'action.refresh': 'Refresh',
  'job.url': 'Open posting',
  'appstatus.drafted': 'drafted',
  'appstatus.applied': 'applied',
  'appstatus.interview': 'interview',
  'appstatus.offer': 'offer',
  'appstatus.rejected': 'rejected',
  'appstatus.withdrawn': 'withdrawn',
}

/** One locale's dictionary shape. */
export type JobSearchDict = typeof zh

/**
 * The navigator-language fallback dictionary.
 * @returns the Chinese dictionary on a zh locale, English otherwise.
 */
export function dictionary(): JobSearchDict {
  return typeof navigator !== 'undefined' && navigator.language.startsWith('zh') ? zh : (en as unknown as JobSearchDict)
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
