// 冒烟测试：在 Node 里直接跑 local-service 的检查站归属/冲突/联动/并发规则。
// local-store 在没有 window 时只走内存缓存，pinia 手动激活即可。
import { createPinia, setActivePinia } from 'pinia'

setActivePinia(createPinia())

import { listEntries, runAction } from '@/api/local-service'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
let failures = 0

function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`ok   - ${name}`)
  } else {
    failures += 1
    console.error(`FAIL - ${name}`, extra ?? '')
  }
}

function checkpointRow(id: number) {
  return listEntries('checkpoint').items.find((row) => Number(row.id) === id)
}

function dutyItemsFor(station: string, status?: string) {
  return listEntries('duty').items.filter(
    (row) =>
      row['值勤岗位'] === `防火检查站·${station}` && (status === undefined || row.status === status),
  )
}

// 1. 调度账号越权：只能查看
session.setAccount('admin')
let r = runAction('checkpoint', 1, '升级检查')
check('调度账号升级被拒', !r.ok && r.message.includes('调度查看账号'), r.message)
r = runAction('checkpoint', 1, '关闭站点')
check('调度账号关闭被拒', !r.ok, r.message)

// 2. 跨站账号越权
session.setAccount('lin-weiguo')
r = runAction('checkpoint', 2, '关闭站点')
check('跨站关闭被拒', !r.ok && r.message.includes('跨站账号只能查看'), r.message)

// 3. 两班并发：同站另一班但不是当前值守，不能落地
session.setAccount('he-yexun')
r = runAction('checkpoint', 1, '升级检查')
check('非值守班次升级被拒', !r.ok && r.message.includes('暂无归属权限'), r.message)

// 4. 归属方升级成功，值勤排班多出一份换岗事项
session.setAccount('lin-weiguo')
const dutyBefore = listEntries('duty').total
r = runAction('checkpoint', 1, '升级检查')
check('归属值守升级落地', r.ok, r.message)
check('排班多出一份换岗事项', listEntries('duty').total === dutyBefore + 1)
const openItem = dutyItemsFor('青云岭东入口', '待确认')[0]
check('换岗事项接班人是另一班', openItem?.['接班人员'] === '何夜巡', openItem)
check('换岗事项保留原值守', openItem?.['值勤人员'] === '林卫国', openItem)

// 5. 重复升级幂等拒绝
r = runAction('checkpoint', 1, '升级检查')
check('重复升级被拒', !r.ok && r.message.includes('不用重复操作'), r.message)

// 6. 安排换岗：值守人员交接，待办事项办结
r = runAction('checkpoint', 1, '安排换岗')
check('换岗落地', r.ok, r.message)
check('值守人员已交接给接班人', checkpointRow(1)?.['值守人员'] === '何夜巡', checkpointRow(1))
check('待办事项已办结为已交接', dutyItemsFor('青云岭东入口', '已交接').length === 1)
check('办结记录保留原值守', dutyItemsFor('青云岭东入口', '已交接')[0]?.['值勤人员'] === '林卫国')

// 7. 换岗后原班次失去归属（两班并发只有归属方落地）
session.setAccount('lin-weiguo')
r = runAction('checkpoint', 1, '升级检查')
check('原班次换岗后被拒', !r.ok && r.message.includes('暂无归属权限'), r.message)

// 8. 新值守升级后再关闭：关闭优先，待办换岗事项暂缓保留
session.setAccount('he-yexun')
r = runAction('checkpoint', 1, '升级检查')
check('新值守升级落地', r.ok, r.message)
check('又新增一份换岗事项', dutyItemsFor('青云岭东入口', '待确认').length === 1)
r = runAction('checkpoint', 1, '关闭站点')
check('关闭落地并提示保留', r.ok && r.message.includes('暂缓保留'), r.message)
check('关闭后值守人员未清空', checkpointRow(1)?.['值守人员'] === '何夜巡', checkpointRow(1))
const suspended = dutyItemsFor('青云岭东入口', '待确认')
check('待办事项暂缓保留未删除', suspended.length === 1, suspended)
check('暂缓事项已标注', String(suspended[0]?.['交接记录']).includes('换岗暂缓'), suspended[0])

// 9. 关闭优先：已关闭站点不能安排换岗，但可升级检查恢复
r = runAction('checkpoint', 1, '安排换岗')
check('关闭后换岗被拒', !r.ok && r.message.includes('关闭优先'), r.message)
r = runAction('checkpoint', 1, '升级检查')
check('升级检查可恢复运行', r.ok, r.message)

// 10. 关闭状态重复关闭幂等
session.setAccount('chen-shoushan')
r = runAction('checkpoint', 2, '关闭站点')
check('重复关闭被拒', !r.ok && r.message.includes('不用重复操作'), r.message)

if (failures > 0) {
  console.error(`\n${failures} 个断言失败`)
  process.exit(1)
}
console.log('\n全部断言通过')
