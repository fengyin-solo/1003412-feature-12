import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// v2：检查站引入乐观锁版本号；旧版 v1 数据存在时一次性继承，缺的字段按种子补齐。
const STORAGE_KEY = 'forest-fire-patrol:entries:v2'
const LEGACY_STORAGE_KEY = 'forest-fire-patrol:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function migrateRows(saved: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  // 旧版检查站数据补齐 v2 字段：版本号从 1 起，原值守人员默认就是当前值守人员。
  const checkpointRows = saved['checkpoint']
  if (Array.isArray(checkpointRows)) {
    saved['checkpoint'] = checkpointRows.map((row) => {
      if (typeof row.version === 'number') {
        return row
      }
      const guard = String(row['值守人员'] ?? '')
      return {
        ...row,
        version: 1,
        原值守人员: row['原值守人员'] ?? guard,
        值守记录: row['值守记录'] ?? (guard ? `${guard}历史值守记录（迁移自旧版数据）` : ''),
      }
    })
  }
  return saved
}

function mergeSeed(saved: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  // 新版本新增模块/字段时，以种子为底，再覆盖浏览器里的存量数据。
  return migrateRows({ ...clone(SEED_ROWS), ...clone(saved) })
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    // 无浏览器环境（如单测）时把内存缓存当作持久层，快照仍能读到上次提交。
    return cache === null ? fallback : clone(cache)
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      return mergeSeed(JSON.parse(raw) as Record<string, EntryRow[]>)
    } catch {
      window.localStorage.removeItem(STORAGE_KEY)
    }
  }
  // 首次升级到 v2：沿用旧 key 里的数据，避免老用户数据被重置。
  const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY)
  if (legacy) {
    try {
      const migrated = mergeSeed(JSON.parse(legacy) as Record<string, EntryRow[]>)
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
      return migrated
    } catch {
      window.localStorage.removeItem(LEGACY_STORAGE_KEY)
    }
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
  return fallback
}

let cache: Record<string, EntryRow[]> | null = null

// 多标签页并发：别的标签页落盘后，本页缓存作废，下次读取以存储为准。
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      cache = null
    }
  })
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

// 取一份脱离引用的最新快照：并发判定、CAS 提交都基于它，改前改后都不碰缓存对象。
export function snapshotRows(): Record<string, EntryRow[]> {
  cache = readStorage()
  return cache
}

// 整表提交：localStorage 与内存缓存一次性替换，跨模块联动（检查站 + 值勤排班）在同一提交里原子落地。
export function persistRows(next: Record<string, EntryRow[]>): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  persistRows({ ...snapshotRows(), [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
