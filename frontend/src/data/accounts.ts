// 检查站值守账号名册：归属权限按「站点位置 + 值守人员」判定。
// station 为空字符串表示调度查看账号，不归属任何站点，跨站只能查看。
export type DutyAccount = {
  key: string
  name: string
  station: string
  shift: string
}

export const ACCOUNTS: DutyAccount[] = [
  { key: 'admin', name: '值班管理员', station: '', shift: '白班 08:00-20:00' },
  { key: 'lin-weiguo', name: '林卫国', station: '青云岭东入口', shift: '白班 08:00-20:00' },
  { key: 'he-yexun', name: '何夜巡', station: '青云岭东入口', shift: '夜班 20:00-08:00' },
  { key: 'chen-shoushan', name: '陈守山', station: '黑松梁北卡口', shift: '白班 08:00-20:00' },
  { key: 'zhou-shouye', name: '周守夜', station: '黑松梁北卡口', shift: '夜班 20:00-08:00' },
  { key: 'zhao-xunlin', name: '赵巡林', station: '白桦沟南道口', shift: '白班 08:00-20:00' },
  { key: 'wu-xingye', name: '吴星野', station: '白桦沟南道口', shift: '夜班 20:00-08:00' },
]

export function accountByKey(key: string): DutyAccount {
  return ACCOUNTS.find((item) => item.key === key) ?? ACCOUNTS[0]
}

// 同站点的另一班就是接班人：安排换岗时把值守人员交给他。
export function reliefFor(station: string, keeper: string): DutyAccount | undefined {
  return ACCOUNTS.find((item) => item.station === station && item.name !== keeper)
}
