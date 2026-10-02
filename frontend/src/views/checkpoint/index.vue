<template>
  <section class="page" data-module="checkpoint">
    <header class="page-head">
      <div>
        <h2>防火检查站管理</h2>
        <p class="page-desc">维护防火检查站，围绕站点编号、站点位置、值守人员、检查项目做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记防火检查站</button>
        <button class="btn" type="button" @click="exportRows">导出防火检查站清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <div class="owner-bar">
      <span class="owner-label">当前登录账号：</span>
      <select
        class="owner-select"
        :value="identityKey"
        @change="switchAccount(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="account in presetAccounts" :key="account.operator" :value="account.operator">
          {{ account.operator }}（{{ account.stationLocation || '无固定站点' }} · {{ account.shiftLabel }}）
        </option>
      </select>
      <span class="owner-hint">
        归属权限按「站点位置 + 值守人员」判定：本站值守人员可升级检查/关闭站点/安排换岗，跨站账号只读，越权操作会返回拒绝原因。
      </span>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>归属</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <span v-if="ownsRow(row)" class="owner-badge mine">本站值守</span>
            <span v-else class="owner-badge other">跨站只读</span>
          </td>
          <td>{{ row.status }}<span class="version-tag">v{{ Number(row.version ?? 0) }}</span></td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              :class="{ disabled: !ownsRow(row) }"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无防火检查站数据，可先登记防火检查站</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条防火检查站记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="successMessage" class="success-text">{{ successMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  checkpointStatusSummary,
  ownsStation,
  submitCheckpointAction,
  type OperatorIdentity,
} from '@/api/checkpoint-service'
import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import { PRESET_ACCOUNTS, useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('checkpoint')
const session = useSessionStore()
const presetAccounts = PRESET_ACCOUNTS
const columns = ["站点编号", "站点位置", "值守人员", "原值守人员", "检查项目", "通行车辆数", "收缴火种数", "值班日期", "运行状态"]
const actions = ["升级检查", "关闭站点", "安排换岗"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["站点编号", "站点位置", "值守人员"]

const identity = computed<OperatorIdentity>(() => ({
  operator: session.operator,
  stationLocation: session.stationLocation,
  shiftLabel: session.shiftLabel,
}))

// select 的 value 用姓名即可（演示账号姓名唯一）。
const identityKey = computed(() => session.operator)

function switchAccount(operator: string) {
  const account = presetAccounts.find((item) => item.operator === operator)
  if (account) {
    session.switchAccount(account)
    errorMessage.value = ''
    successMessage.value = ''
    reload()
  }
}

function ownsRow(row: EntryRow): boolean {
  return ownsStation(row, identity.value)
}

const statusSummary = computed(() => checkpointStatusSummary(rows.value))

const stats = computed(() => {
  const totalCount = rows.value.length
  const normalCount = rows.value.filter((row) => String(row.status) === '正常检查').length
  const seized = rows.value.reduce((sum, row) => sum + (Number(row['收缴火种数']) || 0), 0)
  return [
    { label: '站点总数', value: totalCount },
    { label: '正常检查数', value: normalCount },
    { label: '收缴火种数', value: seized },
  ]
})

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '防火检查站登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  successMessage.value = ''
  // 携带渲染时版本号：若另一班次已抢先落地，本次提交会被乐观锁拒绝。
  const result = submitCheckpointAction(Number(row.id), action, identity.value, Number(row.version ?? 0))
  if (!result.ok) {
    errorMessage.value = result.message
    reload()
    return
  }
  successMessage.value = result.message
  reload()
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '防火检查站列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.owner-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
  padding: 10px 12px;
  border: 1px solid var(--border-color, #d8dee6);
  border-radius: 8px;
  background: #f7f9fc;
}

.owner-label {
  font-weight: 600;
}

.owner-select {
  min-width: 320px;
  padding: 6px 8px;
  border: 1px solid var(--border-color, #d8dee6);
  border-radius: 6px;
  background: #fff;
}

.owner-hint {
  color: #6b7480;
  font-size: 12px;
}

.owner-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  white-space: nowrap;
}

.owner-badge.mine {
  background: #e4f6ea;
  color: #1d7a3e;
}

.owner-badge.other {
  background: #f0f1f3;
  color: #7a828c;
}

.link.disabled {
  opacity: 0.45;
}

.version-tag {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 4px;
  background: #eef1f5;
  color: #8a93a0;
  font-size: 11px;
}

.success-text {
  color: #1d7a3e;
}
</style>
