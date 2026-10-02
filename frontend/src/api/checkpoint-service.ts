import { persistRows, snapshotRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 防火检查站专用业务规则（不经过通用 runAction）：
// 1) 按「站点位置 + 值守人员」建立归属，本站值守人员才能升级检查/关闭站点/安排换岗，跨站账号只读；
// 2) 关闭与换岗冲突时关闭优先：临时关闭的站点拒绝升级与换岗，原值守人员及其值守记录原样保留；
// 3) 升级检查成功后，在「值勤排班」模块原子追加一份换岗事项；
// 4) 乐观锁版本号 + 整表 CAS：两个班次并发提交时，只有归属方的首次提交落地，陈旧提交被拒绝。

export const CHECKPOINT_KEY = 'checkpoint'
export const DUTY_KEY = 'duty'

export const CHECKPOINT_ACTIONS = ['升级检查', '关闭站点', '安排换岗'] as const
export type CheckpointAction = (typeof CHECKPOINT_ACTIONS)[number]

export type OperatorIdentity = {
  operator: string
  stationLocation: string
  shiftLabel: string
}

const STATUS_NORMAL = '正常检查'
const STATUS_CLOSED = '临时关闭'
const STATUS_ESCALATED = '升级检查'
const STATUS_WAITING_RELAY = '等待换岗'

const ORIGINAL_GUARD_FIELD = '原值守人员'
const GUARD_LOG_FIELD = '值守记录'

// 归属判定：站点位置与值守人员同时命中当前账号，才算「本站值守人员」。
export function ownsStation(row: EntryRow, identity: OperatorIdentity): boolean {
  if (!identity.operator || !identity.stationLocation) {
    return false
  }
  return (
    String(row['站点位置'] ?? '') === identity.stationLocation &&
    String(row['值守人员'] ?? '') === identity.operator
  )
}

function denyReason(row: EntryRow, identity: OperatorIdentity, action: string): string {
  const code = String(row['站点编号'] ?? row.id)
  const location = String(row['站点位置'] ?? '未知位置')
  const guard = String(row['值守人员'] ?? '未安排')
  if (!identity.stationLocation) {
    return `越权拒绝：当前账号「${identity.operator}」是机动巡检账号，未归属任何检查站，只能查看，不能执行「${action}」`
  }
  if (String(row['站点位置'] ?? '') !== identity.stationLocation) {
    return `越权拒绝：${code}（${location}）归属值守人员「${guard}」，当前账号归属「${identity.stationLocation}」，跨站账号只能查看，不能执行「${action}」`
  }
  return `越权拒绝：${code}（${location}）的本站值守人员是「${guard}」，当前账号「${identity.operator}」不是本站值守人员，只能查看，不能执行「${action}」`
}

function transitionDenied(current: string, action: string, row: EntryRow): string | null {
  const code = String(row['站点编号'] ?? row.id)
  const guard = String(row[ORIGINAL_GUARD_FIELD] ?? row['值守人员'] ?? '')
  if (action === '升级检查') {
    if (current === STATUS_ESCALATED) {
      return `站点 ${code} 已处于升级检查，不用重复操作`
    }
    if (current === STATUS_CLOSED) {
      // 关闭优先：关闭期间拒绝升级，原值守记录保留备查。
      return `站点 ${code} 已临时关闭，按「关闭优先」规则关闭期间拒绝升级检查；原值守人员「${guard}」的值守记录已保留，站点恢复后再升级`
    }
  }
  if (action === '关闭站点') {
    if (current === STATUS_CLOSED) {
      return `站点 ${code} 已经临时关闭，不用重复操作；原值守人员「${guard}」的值守记录仍在`
    }
  }
  if (action === '安排换岗') {
    if (current === STATUS_WAITING_RELAY) {
      return `站点 ${code} 已在等待换岗，不用重复申请；原值守人员「${guard}」的值守记录已保留`
    }
    if (current === STATUS_CLOSED) {
      // 关闭与换岗冲突：关闭优先，换岗申请被拒，但值守人员字段与值守记录不动。
      return `站点 ${code} 已临时关闭，按「关闭优先」规则关闭期间不安排换岗；原值守人员「${guard}」的值守记录已保留，站点恢复后再行换岗`
    }
  }
  return null
}

function appendLog(row: EntryRow, line: string): string {
  const previous = String(row[GUARD_LOG_FIELD] ?? '').trim()
  return previous ? `${previous}；${line}` : line
}

function todayText(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function nextDutyId(dutyRows: EntryRow[]): number {
  return dutyRows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
}

// 升级检查联动：在值勤排班模块多出一份换岗事项，排班字段沿用值勤排班模块的既有结构。
function buildRelayDutyEntry(
  station: EntryRow,
  identity: OperatorIdentity,
  dutyRows: EntryRow[],
): EntryRow {
  const date = todayText()
  const code = String(station['站点编号'] ?? station.id)
  const location = String(station['站点位置'] ?? '')
  const originalGuard = String(station[ORIGINAL_GUARD_FIELD] ?? station['值守人员'] ?? '')
  return {
    id: nextDutyId(dutyRows),
    status: '待确认',
    pending: true,
    abnormal: false,
    version: 1,
    排班编号: `DUTY-RELAY-${code}`,
    值勤日期: date,
    值勤时段: identity.shiftLabel || '随升级检查班次',
    值勤岗位: `防火检查站换岗事项｜${location}（${code}）`,
    值勤人员: originalGuard,
    接班人员: '待安排',
    交接记录: `${date} 检查站「${location}」升级检查成功，联动生成换岗事项：请安排接班人到岗与${originalGuard}交接；发起人 ${identity.operator}`,
    排班状态: '待确认',
  }
}

export type SubmitOutcome = ActionResult & { station?: EntryRow; relayDuty?: EntryRow }

// 检查站动作统一入口。expectedVersion 为页面渲染时看到的版本号，
// 与最新数据不一致说明已被另一班次抢先提交，本次操作拒绝落地。
export function submitCheckpointAction(
  id: number,
  action: string,
  identity: OperatorIdentity,
  expectedVersion?: number,
): SubmitOutcome {
  if (!CHECKPOINT_ACTIONS.includes(action as CheckpointAction)) {
    return { ok: false, message: `防火检查站没有登记「${action}」这个动作` }
  }

  // 取最新快照，所有判定都以它为准，保证并发读到的是同一份事实。
  const snapshot = snapshotRows()
  const checkpointRows = [...(snapshot[CHECKPOINT_KEY] ?? [])]
  const index = checkpointRows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的防火检查站` }
  }
  const current = checkpointRows[index]

  // 归属权限：非本站值守人员一律只读，返回具体拒绝原因。
  if (!ownsStation(current, identity)) {
    return { ok: false, message: denyReason(current, identity, action) }
  }

  const status = String(current.status)

  // 乐观锁：陈旧提交（已被另一班次落地）拒绝，避免后到的越权/过期操作覆盖现场。
  const currentVersion = Number(current.version ?? 0)
  if (expectedVersion !== undefined && Number(expectedVersion) !== currentVersion) {
    return {
      ok: false,
      message: `该站点刚被另一班次更新（数据版本 v${currentVersion}），请刷新查看最新值守现场后再操作，本次「${action}」未落地`,
    }
  }

  const blocked = transitionDenied(status, action, current)
  if (blocked) {
    return { ok: false, message: blocked }
  }

  const date = todayText()
  const originalGuard = String(current[ORIGINAL_GUARD_FIELD] ?? current['值守人员'] ?? '')
  const base: EntryRow = {
    ...current,
    version: currentVersion + 1,
    // 任何流转都不改写、不丢失原值守人员。
    [ORIGINAL_GUARD_FIELD]: originalGuard,
  }

  let updated: EntryRow
  let message: string
  switch (action as CheckpointAction) {
    case '升级检查':
      updated = {
        ...base,
        status: STATUS_ESCALATED,
        pending: true,
        abnormal: false,
        [GUARD_LOG_FIELD]: appendLog(
          current,
          `${date} ${identity.operator} 启动升级检查，增派值守力量并联动值勤排班安排换岗`,
        ),
      }
      break
    case '关闭站点':
      // 关闭优先：值守人员字段保持不变，原值守记录原样保留并追加关闭说明。
      updated = {
        ...base,
        status: STATUS_CLOSED,
        pending: true,
        abnormal: false,
        [GUARD_LOG_FIELD]: appendLog(
          current,
          `${date} ${identity.operator} 临时关闭站点（关闭优先于换岗），原值守人员「${originalGuard}」值守记录保留备查`,
        ),
      }
      break
    case '安排换岗':
      updated = {
        ...base,
        status: STATUS_WAITING_RELAY,
        pending: true,
        abnormal: false,
        [GUARD_LOG_FIELD]: appendLog(
          current,
          `${date} ${identity.operator} 申请换岗，等待接班人到岗交接，原值守人员「${originalGuard}」值守记录保留`,
        ),
      }
      break
  }

  checkpointRows[index] = updated

  // 整表 CAS 提交：检查站状态与值勤排班的换岗事项在同一次落盘中原子生效。
  const nextAll: Record<string, EntryRow[]> = { ...snapshot, [CHECKPOINT_KEY]: checkpointRows }
  let relayDuty: EntryRow | undefined
  if (action === '升级检查') {
    const dutyRows = [...(snapshot[DUTY_KEY] ?? [])]
    relayDuty = buildRelayDutyEntry(updated, identity, dutyRows)
    dutyRows.push(relayDuty)
    nextAll[DUTY_KEY] = dutyRows
  }
  persistRows(nextAll)

  if (action === '升级检查') {
    message = `站点已升级检查，当前状态「${STATUS_ESCALATED}」；已同步在值勤排班追加 1 条换岗事项（${relayDuty!['排班编号']}）`
  } else if (action === '关闭站点') {
    message = `站点已临时关闭，原值守人员「${originalGuard}」及其值守记录均已保留；关闭期间拒绝升级与换岗`
  } else {
    message = `已登记换岗申请，站点进入「${STATUS_WAITING_RELAY}」；原值守人员「${originalGuard}」值守记录已保留`
  }
  return { ok: true, message, station: updated, relayDuty }
}

export function checkpointStatusSummary(rows: EntryRow[]) {
  return [STATUS_NORMAL, STATUS_CLOSED, STATUS_ESCALATED, STATUS_WAITING_RELAY].map((status) => ({
    status,
    count: rows.filter((row) => String(row.status) === status).length,
  }))
}
