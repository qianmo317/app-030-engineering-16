<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { formatBytes, loadGateReport, type GateReport } from '../logic/releaseGate'

defineProps<{ title: string }>()

const report = ref<GateReport | null>(null)
const loaded = ref(false)

onMounted(async () => {
  report.value = await loadGateReport()
  loaded.value = true
})

const statusLabel = { pass: '过', fail: '未过', skip: '跳过' } as const
const statusClass = { pass: 'badge-ok', fail: 'badge-danger', skip: 'badge-warn' } as const

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN')
}
</script>

<template>
  <div class="card">
    <div class="card-head">
      <h3>{{ title }}</h3>
      <div class="spacer"></div>
      <span v-if="report" class="badge" :class="report.verdict === 'pass' ? 'badge-ok' : 'badge-danger'">
        {{ report.verdict === 'pass' ? '关卡通过' : '关卡未通过' }}
      </span>
    </div>
    <div class="card-body tight">
      <p v-if="!loaded" class="hint">正在读取机读结论…</p>
      <p v-else-if="!report" class="notice notice-warn">
        未找到 release-gate-report.json：当前是开发模式或尚未跑发布关卡。打包（npm run gate）、本页与导出说明三处以该文件为唯一结论来源，交包前必须先跑关卡。
      </p>
      <template v-else>
        <p class="hint">
          提交 {{ report.commit }} ｜ 关卡时间 {{ formatTime(report.generatedAt) }} ｜ 模式
          {{ report.mode === 'hard' ? '硬拦' : '只出报告' }}
          <template v-if="report.dist">｜ 包体 {{ report.dist.fileCount }} 个文件 / {{ formatBytes(report.dist.totalBytes) }}</template>
        </p>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th style="width: 64px">结果</th>
                <th>检查项</th>
                <th>证据 / 跳过原因</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="check in report.checks" :key="check.id">
                <td><span class="badge" :class="statusClass[check.status]">{{ statusLabel[check.status] }}</span></td>
                <td>{{ check.title }}</td>
                <td>
                  <div v-for="(line, i) in check.evidence" :key="i" class="hint" style="white-space: normal">{{ line }}</div>
                  <div v-if="check.skipReason" class="hint" style="white-space: normal">跳过原因：{{ check.skipReason }}</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="hint" style="margin-top: 8px">
          取舍：{{ report.policy.sampleData }}。{{ report.policy.failureMode }}。详见 release-gate.md。
        </p>
      </template>
    </div>
  </div>
</template>
