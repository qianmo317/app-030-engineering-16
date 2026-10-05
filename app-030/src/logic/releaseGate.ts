/**
 * 发布关卡机读结论的唯一读取入口。
 * dist/release-gate-report.json 由 scripts/release-gate.mjs 生成；
 * 打包脚本（exit code）、首页「交付自检」、导出页「导出说明」三处只读这一份，不各写判断。
 */
export type GateCheckStatus = 'pass' | 'fail' | 'skip'

export interface GateCheck {
  id: string
  title: string
  status: GateCheckStatus
  evidence: string[]
  skipReason?: string
}

export interface GateReport {
  version: 1
  app: string
  commit: string
  generatedAt: string
  mode: 'hard' | 'report'
  policy: { sampleData: string; failureMode: string }
  dist: { fileCount: number; totalBytes: number } | null
  checks: GateCheck[]
  verdict: 'pass' | 'fail'
}

let cached: Promise<GateReport | null> | null = null

export function loadGateReport(): Promise<GateReport | null> {
  if (!cached) {
    cached = fetch(`${import.meta.env.BASE_URL}release-gate-report.json`, { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<GateReport>) : null))
      .catch(() => null)
  }
  return cached
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`
}
