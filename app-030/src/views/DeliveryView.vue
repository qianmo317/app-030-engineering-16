<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  loadDeliveryReport,
  statusBadgeClass,
  statusLabel,
  type DeliveryReport
} from '../logic/delivery'

const report = ref<DeliveryReport | null>(null)
const error = ref('')

onMounted(async () => {
  const result = await loadDeliveryReport()
  report.value = result.report
  error.value = result.error ?? ''
})

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1>交付自检</h1>
        <div class="sub">
          本页只渲染打包关卡产出的机读结论 <code>delivery-report.json</code>，与打包命令、导出说明读的是同一份，页面不自行判断
        </div>
      </div>
    </div>

    <div v-if="error" class="card card-accent-danger">
      <div class="card-body">
        <p class="notice notice-error">{{ error }}</p>
      </div>
    </div>

    <template v-else-if="report">
      <div class="card" :class="report.overall === 'pass' ? '' : 'card-accent-danger'">
        <div class="card-head">
          <h2>总体结论：{{ report.overall === 'pass' ? '过，可以交付' : '不过，不得交付' }}</h2>
          <div class="spacer"></div>
          <span class="badge" :class="report.overall === 'pass' ? 'badge-ok' : 'badge-danger'">
            {{ report.overall === 'pass' ? '过' : '不过' }}
          </span>
        </div>
        <div class="card-body tight">
          <p>
            应用 {{ report.app }} ｜ 提交 <code>{{ report.commit }}</code> ｜ 关卡模式
            {{ report.mode === 'enforce' ? '硬拦（任一不过即打包失败）' : '只出报告' }} ｜ 生成于 {{ formatTime(report.generatedAt) }}
          </p>
          <p class="hint">
            示例数据取舍：{{ report.policy.sampleDataRule }}
          </p>
          <p class="hint">
            硬拦取舍：{{ report.policy.hardBlockRule }}
          </p>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>逐项检查（{{ report.checks.filter((c) => c.status === 'pass').length }} 过 /
            {{ report.checks.filter((c) => c.status === 'fail').length }} 不过 /
            {{ report.checks.filter((c) => c.status === 'skip').length }} 跳过）</h2>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th class="num">#</th>
                <th>检查项</th>
                <th>结论</th>
                <th>证据 / 跳过原因</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="check in report.checks" :key="check.id">
                <td class="num">{{ check.order }}</td>
                <td>{{ check.title }}</td>
                <td>
                  <span class="badge" :class="statusBadgeClass(check.status)">{{ statusLabel(check.status) }}</span>
                </td>
                <td>
                  <ul style="margin: 0; padding-left: 18px">
                    <li v-for="(line, i) in check.evidence" :key="i">{{ line }}</li>
                    <li v-if="check.skipReason"><b>跳过原因：</b>{{ check.skipReason }}</li>
                  </ul>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </section>
</template>
