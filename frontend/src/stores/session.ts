import { defineStore } from 'pinia'

// 演示用账号：归属权限按「站点位置 + 值守人员」两个维度判定。
// 前两个账号分别归属两座检查站，第三个是无站点归属的巡检账号（跨站只读）。
export type SessionAccount = {
  operator: string
  stationLocation: string
  shiftLabel: string
}

export const PRESET_ACCOUNTS: SessionAccount[] = [
  { operator: '赵卫东', stationLocation: '青松岭入山口检查站', shiftLabel: '白班 08:00-20:00' },
  { operator: '孙桂芳', stationLocation: '北坡林场检查站', shiftLabel: '夜班 20:00-次日08:00' },
  { operator: '巡检员周明', stationLocation: '', shiftLabel: '机动巡检（无固定站点）' },
]

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: PRESET_ACCOUNTS[0].operator,
    stationLocation: PRESET_ACCOUNTS[0].stationLocation,
    shiftLabel: PRESET_ACCOUNTS[0].shiftLabel,
    scope: '森林防火巡护管理系统',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    // 切换当前登录账号（演示归属/越权场景），归属站点为空表示没有任何站点归属。
    switchAccount(account: SessionAccount) {
      this.operator = account.operator
      this.stationLocation = account.stationLocation
      this.shiftLabel = account.shiftLabel
    },
  },
})
