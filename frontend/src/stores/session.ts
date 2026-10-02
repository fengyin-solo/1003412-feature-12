import { defineStore } from 'pinia'

import { accountByKey } from '@/data/accounts'

export const useSessionStore = defineStore('session', {
  state: () => ({
    accountKey: 'admin',
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '森林防火巡护管理系统',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    currentAccount: (state) => accountByKey(state.accountKey),
  },
  actions: {
    setAccount(key: string) {
      const account = accountByKey(key)
      this.accountKey = account.key
      this.operator = account.name
      this.shiftLabel = account.shift
    },
    setShift(label: string) {
      this.shiftLabel = label
    },
  },
})
