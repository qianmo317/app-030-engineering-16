/**
 * 交付关卡机读结论的唯一读取入口。
 *
 * 打包侧（scripts/delivery-gate.mjs）、交付自检页（/delivery）、导出说明（导出页卡片）
 * 三处共读同一份 /delivery-report.json，任何一处都不得自行重写判断逻辑。
 */

export type GateCheckStatus = 'pass' | 'fail' | 'skip'

export interface GateCheck {
  id: string
  order: number
  title: string
  status: GateCheckStatus
  evidence: string[]
  skipReason: string | null
}

export interface DeliveryReport {
  schema: string
  app: string
  commit: string
  generatedAt: string
  mode: 'enforce' | 'report'
  overall: 'pass' | 'fail'
  policy: {
    sampleData: string
    sampleDataRule: string
    hardBlockRule: string
  }
  checks: GateCheck[]
}

export interface DeliveryReportResult {
  report: DeliveryReport | null
  error: string | null
}

export async function loadDeliveryReport(): Promise<DeliveryReportResult> {
  try {
    const res = await fetch('/delivery-report.json', { cache: 'no-store' })
    if (!res.ok) {
      return { report: null, error: `未找到机读结论（HTTP ${res.status}）。请先在打包机上运行 npm run gate 生成 delivery-report.json。` }
    }
    const data = (await res.json()) as DeliveryReport
    if (data.schema !== 'delivery-gate/v1' || !Array.isArray(data.checks)) {
      return { report: null, error: 'delivery-report.json 格式不是 delivery-gate/v1，可能已被篡改或来自旧版本关卡。' }
    }
    return { report: data, error: null }
  } catch (err) {
    return { report: null, error: `读取机读结论失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

export function statusLabel(status: GateCheckStatus): string {
  return status === 'pass' ? '过' : status === 'fail' ? '不过' : '跳过'
}

export function statusBadgeClass(status: GateCheckStatus): string {
  return status === 'pass' ? 'badge-ok' : status === 'fail' ? 'badge-danger' : 'badge-warn'
}
