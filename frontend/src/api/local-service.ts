import { reliefFor } from '@/data/accounts'
import type { DutyAccount } from '@/data/accounts'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { useSessionStore } from '@/stores/session'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  if (key === CHECKPOINT_KEY) {
    return runCheckpointAction(meta, rows, index, action, target)
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// —— 防火检查站专属流转 ——————————————————————————————————————
// 归属权限：按「站点位置 + 值守人员」判定，只有本站当前值守人员能升级检查、关闭站点、
// 安排换岗；跨站账号和调度账号只能查看，越权操作在这里拦下并说明原因。归属在落地前
// 基于最新数据校验，所以两个班次同时操作时，只有当前值守班次能写进去。
// 冲突约定：关闭优先于换岗——已临时关闭的站点不能再安排换岗（先升级检查恢复运行），
// 关闭时未完成的换岗事项和原值守记录一律保留，不删记录、不改值守人员。
const CHECKPOINT_KEY = 'checkpoint'
const DUTY_KEY = 'duty'
const DUTY_OPEN_STATUS = '待确认'

function dutyPostOf(station: string): string {
  return `防火检查站·${station}`
}

function today(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function nextDutyId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function checkpointDenial(
  account: DutyAccount,
  station: string,
  keeper: string,
  action: string,
): string | null {
  if (account.station === station && account.name === keeper) {
    return null
  }
  if (!account.station) {
    return `越权操作已拒绝：「${account.name}」是调度查看账号，不归属任何检查站，只能查看，不能执行「${action}」`
  }
  if (account.station !== station) {
    return `越权操作已拒绝：「${account.name}」归属站点「${account.station}」，无权对「${station}」（值守：${keeper}）执行「${action}」，跨站账号只能查看`
  }
  return `越权操作已拒绝：站点「${station}」当前由「${keeper}」值守，「${account.name}」暂无归属权限；两班并发操作时只有归属班次能落地`
}

function runCheckpointAction(
  meta: ModuleMeta,
  rows: EntryRow[],
  index: number,
  action: string,
  target: string,
): ActionResult {
  const row = rows[index]
  const station = String(row['站点位置'] ?? '')
  const keeper = String(row['值守人员'] ?? '')
  const account = useSessionStore().currentAccount

  const denial = checkpointDenial(account, station, keeper, action)
  if (denial) {
    return { ok: false, message: denial }
  }

  const current = String(row.status)
  const lastStatus = meta.statuses[meta.statuses.length - 1]

  if (action === '安排换岗') {
    // 关闭优先：已临时关闭的站点不能换岗，先升级检查恢复运行。
    if (current === '临时关闭') {
      return {
        ok: false,
        message: `操作已拒绝：站点「${station}」已临时关闭，关闭优先于换岗，请先通过「升级检查」恢复站点运行`,
      }
    }
    const relief = reliefFor(station, keeper)
    if (!relief) {
      return { ok: false, message: `操作已拒绝：站点「${station}」没有登记接班班次，无法安排换岗` }
    }
    // 换岗交接：值守人员交给接班人，原值守记录写进值勤排班留档。
    const next = [...rows]
    next[index] = {
      ...row,
      值守人员: relief.name,
      status: target,
      pending: target !== lastStatus,
      abnormal: false,
    }
    saveRows(CHECKPOINT_KEY, next)
    recordHandover(row, keeper, relief)
    return {
      ok: true,
      message: `${meta.entity}已安排换岗：值守人员由「${keeper}」交接给「${relief.name}」，原值守记录已写入值勤排班`,
    }
  }

  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  const next = [...rows]
  next[index] = {
    ...row,
    status: target,
    pending: target !== lastStatus,
    abnormal: false,
  }
  saveRows(CHECKPOINT_KEY, next)

  if (action === '升级检查') {
    // 升级成功联动值勤排班：多出一份换岗事项，等接班班次确认。
    const item = appendShiftItem(row, keeper, reliefFor(station, keeper))
    return {
      ok: true,
      message: `${meta.entity}已升级检查，当前状态「${target}」；值勤排班已新增换岗事项「${item['排班编号']}」（接班：${item['接班人员']}）`,
    }
  }

  if (action === '关闭站点') {
    // 关闭优先于换岗：关闭照常落地，未完成的换岗事项暂缓保留，原值守记录不动。
    const kept = suspendShiftItems(station)
    const suffix =
      kept > 0 ? `；关闭优先：${kept} 条待办换岗事项已暂缓保留，原值守记录未改动` : '；原值守记录已保留'
    return { ok: true, message: `${meta.entity}已关闭站点，当前状态「${target}」${suffix}` }
  }

  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 升级检查联动：往值勤排班追加一份换岗事项（待确认）。
function appendShiftItem(row: EntryRow, keeper: string, relief: DutyAccount | undefined): EntryRow {
  const dutyRows = listRows(DUTY_KEY)
  const id = nextDutyId(dutyRows)
  const item: EntryRow = {
    id,
    status: DUTY_OPEN_STATUS,
    pending: true,
    abnormal: false,
    排班编号: `DUTY-${String(id).padStart(4, '0')}`,
    值勤日期: today(),
    值勤时段: relief?.shift ?? '待排班',
    值勤岗位: dutyPostOf(String(row['站点位置'] ?? '')),
    值勤人员: keeper,
    接班人员: relief?.name ?? '待排班',
    交接记录: `${String(row['站点编号'] ?? '')} 升级检查，安排换岗增援`,
    排班状态: DUTY_OPEN_STATUS,
  }
  saveRows(DUTY_KEY, [...dutyRows, item])
  return item
}

// 换岗交接：有未完成的换岗事项就把它办结，没有就补一条已交接记录，原值守人员都留档。
function recordHandover(row: EntryRow, keeper: string, relief: DutyAccount): void {
  const station = String(row['站点位置'] ?? '')
  const dutyRows = listRows(DUTY_KEY)
  const openIndex = dutyRows.findIndex(
    (item) => item['值勤岗位'] === dutyPostOf(station) && item.status === DUTY_OPEN_STATUS,
  )
  if (openIndex >= 0) {
    const next = [...dutyRows]
    next[openIndex] = {
      ...next[openIndex],
      status: '已交接',
      pending: false,
      接班人员: relief.name,
      交接记录: `${String(next[openIndex]['交接记录'] ?? '')}；${today()}完成交接：${keeper} → ${relief.name}`,
      排班状态: '已交接',
    }
    saveRows(DUTY_KEY, next)
    return
  }
  const id = nextDutyId(dutyRows)
  saveRows(DUTY_KEY, [
    ...dutyRows,
    {
      id,
      status: '已交接',
      pending: false,
      abnormal: false,
      排班编号: `DUTY-${String(id).padStart(4, '0')}`,
      值勤日期: today(),
      值勤时段: relief.shift,
      值勤岗位: dutyPostOf(station),
      值勤人员: keeper,
      接班人员: relief.name,
      交接记录: `${String(row['站点编号'] ?? '')} 例行换岗：${keeper} → ${relief.name}`,
      排班状态: '已交接',
    },
  ])
}

// 关闭站点时：未完成的换岗事项暂缓但保留，原值守记录一条不删。
function suspendShiftItems(station: string): number {
  const dutyRows = listRows(DUTY_KEY)
  let kept = 0
  const next = dutyRows.map((item) => {
    if (item['值勤岗位'] === dutyPostOf(station) && item.status === DUTY_OPEN_STATUS) {
      kept += 1
      return {
        ...item,
        交接记录: `${String(item['交接记录'] ?? '')}（站点已临时关闭，换岗暂缓，原值守记录保留）`,
      }
    }
    return item
  })
  if (kept > 0) {
    saveRows(DUTY_KEY, next)
  }
  return kept
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
