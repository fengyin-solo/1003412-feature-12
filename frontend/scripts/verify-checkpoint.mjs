// 检查站归属权限 / 关闭优先 / 升级联动 / 双班并发 的逻辑自检。
// 运行：npm run verify:checkpoint（用 tsc 编译业务源码到临时目录后在 Node 里跑断言）。
import assert from 'node:assert'

const mem = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  },
  addEventListener: () => {},
}

const { submitCheckpointAction, ownsStation } = await import(
  '../.verify-dist/api/checkpoint-service.js'
)

const zhao = { operator: '赵卫东', stationLocation: '青松岭入山口检查站', shiftLabel: '白班 08:00-20:00' }
const sun = { operator: '孙桂芳', stationLocation: '北坡林场检查站', shiftLabel: '夜班 20:00-次日08:00' }
const inspector = { operator: '巡检员周明', stationLocation: '', shiftLabel: '机动巡检' }
const li = { operator: '李长河', stationLocation: '南河桥头检查站', shiftLabel: '白班' }

const stored = () => JSON.parse(mem.get('forest-fire-patrol:entries:v2'))
const checkpoint = (id) => stored().checkpoint.find((r) => r.id === id)
const dutyRows = () => stored().duty

let result

// 1) 跨站账号对他人站点只能查看，升级/关闭/换岗全部拒绝并返回原因
for (const action of ['升级检查', '关闭站点', '安排换岗']) {
  result = submitCheckpointAction(1, action, sun, 1)
  assert.equal(result.ok, false, `跨站 ${action} 应被拒绝`)
  assert.match(result.message, /越权拒绝/, `跨站 ${action} 需返回拒绝原因`)
  assert.match(result.message, /跨站账号只能查看/, `跨站 ${action} 拒绝原因应说明只读`)
}
// 无站点归属的巡检账号同样只读
result = submitCheckpointAction(1, '升级检查', inspector, 1)
assert.equal(result.ok, false)
assert.match(result.message, /机动巡检账号/)
// 同站但不是本站值守人员也拒绝
result = submitCheckpointAction(
  1,
  '升级检查',
  { operator: '李四', stationLocation: '青松岭入山口检查站', shiftLabel: '白班' },
  1,
)
assert.equal(result.ok, false)
assert.match(result.message, /不是本站值守人员/)
// 越权不产生任何写入
assert.equal(checkpoint(1).version, 1)
assert.equal(checkpoint(1).status, '正常检查')

// 2) 归属方升级检查成功：状态流转 + 值勤排班多出一份换岗事项
const dutyBefore = dutyRows().length
result = submitCheckpointAction(1, '升级检查', zhao, 1)
assert.equal(result.ok, true, result.message)
assert.equal(checkpoint(1).status, '升级检查')
assert.equal(checkpoint(1).version, 2)
assert.equal(dutyRows().length, dutyBefore + 1, '值勤排班应多出一条换岗事项')
const relay = dutyRows().at(-1)
assert.match(String(relay['值勤岗位']), /换岗事项/)
assert.match(String(relay['排班编号']), /DUTY-RELAY-CHEC-0001/)
assert.equal(relay['值勤人员'], '赵卫东', '换岗事项要带出原值守人员')
assert.equal(relay['接班人员'], '待安排')
// 重复升级被拒且不再产生换岗事项
result = submitCheckpointAction(1, '升级检查', zhao, 2)
assert.equal(result.ok, false)
assert.match(result.message, /已处于升级检查/)
assert.equal(dutyRows().length, dutyBefore + 1)

// 3) 关闭与换岗冲突 -> 关闭优先；原值守人员与值守记录保留
const guardBefore = checkpoint(3)['值守人员']
const originalBefore = checkpoint(3)['原值守人员']
const logBefore = checkpoint(3)['值守记录']
result = submitCheckpointAction(3, '关闭站点', li, 1)
assert.equal(result.ok, true, result.message)
assert.equal(checkpoint(3).status, '临时关闭')
assert.equal(checkpoint(3)['值守人员'], guardBefore, '关闭不得改写值守人员')
assert.equal(checkpoint(3)['原值守人员'], originalBefore, '原值守人员必须保留')
assert.ok(checkpoint(3)['值守记录'].startsWith(logBefore), '原值守记录必须原样保留')
assert.ok(checkpoint(3)['值守记录'].includes('关闭优先于换岗'))
// 关闭后再安排换岗/升级都被拒（关闭优先）
result = submitCheckpointAction(3, '安排换岗', li, 2)
assert.equal(result.ok, false)
assert.match(result.message, /关闭优先/)
assert.match(result.message, /值守记录已保留/)
result = submitCheckpointAction(3, '升级检查', li, 2)
assert.equal(result.ok, false)
assert.match(result.message, /关闭期间拒绝升级/)
assert.equal(checkpoint(3)['值守人员'], guardBefore)
// 本就临时关闭的站点2：换岗被拒且人员保留
result = submitCheckpointAction(2, '安排换岗', sun, 2)
assert.equal(result.ok, false)
assert.match(result.message, /关闭优先/)
assert.equal(checkpoint(2)['值守人员'], '孙桂芳')

// 4) 两个班次并发：只有归属方首次提交落地，越权方与陈旧版本提交被拒
result = submitCheckpointAction(1, '关闭站点', zhao, 2)
assert.equal(result.ok, true, result.message)
assert.equal(checkpoint(1).status, '临时关闭')
assert.equal(checkpoint(1).version, 3)
// 跨站班次先被归属拦截
result = submitCheckpointAction(1, '关闭站点', sun, 2)
assert.equal(result.ok, false)
assert.match(result.message, /越权拒绝/)
// 同归属另一窗口仍停留在 v2 -> 陈旧版本被乐观锁拒绝
result = submitCheckpointAction(1, '安排换岗', zhao, 2)
assert.equal(result.ok, false)
assert.match(result.message, /另一班次更新/)
assert.equal(checkpoint(1).version, 3)
assert.equal(checkpoint(1).status, '临时关闭')

// 5) 归属判定纯函数
assert.equal(ownsStation(checkpoint(1), zhao), true)
assert.equal(ownsStation(checkpoint(1), sun), false)
assert.equal(ownsStation(checkpoint(1), inspector), false)

// 6) 旧版 v1 数据迁移：缺版本号/原值守人员的老记录也能正常归属与落盘
mem.clear()
mem.set(
  'forest-fire-patrol:entries',
  JSON.stringify({
    checkpoint: [
      {
        id: 99,
        status: '正常检查',
        pending: true,
        abnormal: false,
        站点编号: 'CHEC-0099',
        站点位置: '旧山口检查站',
        值守人员: '马守山',
      },
    ],
  }),
)
const ma = { operator: '马守山', stationLocation: '旧山口检查站', shiftLabel: '白班' }
result = submitCheckpointAction(99, '升级检查', ma) // 老数据没有版本号，不传期望值
assert.equal(result.ok, true, result.message)
assert.equal(stored().checkpoint[0].version, 2, '迁移后首笔操作版本应从 1 递增到 2')
assert.equal(stored().checkpoint[0]['原值守人员'], '马守山', '迁移应补齐原值守人员')
assert.ok(String(stored().checkpoint[0]['值守记录']).length > 0, '迁移应补齐值守记录')

console.log('✓ 全部断言通过：归属权限 / 关闭优先并保留原值守记录 / 升级联动换岗事项 / 双班并发只归属一方落地 / 旧数据迁移')
