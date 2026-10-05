#!/usr/bin/env node
/**
 * 交付关卡（delivery gate）
 *
 * 用途：打包出门前的唯一一道关卡。跑完产出唯一一份机读结论
 * `delivery-report.json`，同时供三处使用，且三处不得各写一套判断：
 *   1. 打包侧：本脚本按结论给退出码（默认硬拦，--report-only 只出报告）；
 *   2. 页面上的交付自检：/delivery 页面 fetch 同一份 JSON 渲染；
 *   3. 导出说明：导出页读取同一份 JSON 展示结论。
 *
 * 检查顺序（与交付约定一致）：
 *   01 依赖声明里有、锁定里没有的，当场点出来
 *   02 声明 / 锁定 / 实际安装三方是否同一套
 *   03 构建，报出包多大、多少个文件
 *   04 包内卫生：名单类文件（表格 / 逗号分隔文本 / 源码目录 / 依赖目录 / 上次构建残留）
 *   05 首页引到的带版本号文件名是否含内容指纹；指纹资源与首页各自允许多久缓存
 *   06 容器配置：对外写的端口与里面实际听的是否同一个；探活地址与应答内容
 *   07 带编号的地址逐个打开刷新，是否都回到同一页（SPA 回退）
 *   08 构建上下文必须排除的目录（.dockerignore）与上下文里是否混入名单类文件
 *   09 同一提交连续打包两次，文件清单与体积标记是否一致
 *
 * 运行时探活（docker）在本机无对应工具时跳过，并在结论里写明跳过原因。
 */

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const PUBLIC_DIR = path.join(ROOT, 'public')
const REPORT_NAME = 'delivery-report.json'
const REBUILD_DIR = path.join(ROOT, '.gate-dist-b')
const CONTEXT_SIZE_LIMIT = 5 * 1024 * 1024 // 规格：构建上下文 < 5MB

const MODE = process.argv.includes('--report-only') || process.env.GATE_MODE === 'report' ? 'report' : 'enforce'

const checks = []
let buildStartedAt = 0

function record(id, title, status, evidence, skipReason = null) {
  const entry = { id, order: checks.length + 1, title, status, evidence, skipReason }
  checks.push(entry)
  const mark = status === 'pass' ? '过' : status === 'fail' ? '不过' : '跳过'
  console.log(`\n[${String(entry.order).padStart(2, '0')}] ${title} —— ${mark}`)
  for (const line of evidence) console.log(`     ${line}`)
  if (skipReason) console.log(`     跳过原因：${skipReason}`)
  return entry
}

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

function walk(dir, base = dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, base))
    else if (entry.isFile()) out.push({ rel: path.relative(base, full).split(path.sep).join('/'), full })
  }
  return out
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function gitCommit() {
  try {
    return run('git', ['rev-parse', '--short', 'HEAD']).trim()
  } catch {
    return 'unknown'
  }
}

/* ---------- 01 声明了但没锁定的依赖，当场点出来 ---------- */
function checkDeclaredNotLocked() {
  const pkg = readJson(path.join(ROOT, 'package.json'))
  const lock = readJson(path.join(ROOT, 'package-lock.json'))
  const declared = { ...pkg.dependencies, ...pkg.devDependencies }
  const lockRoot = { ...lock.packages?.['']?.dependencies, ...lock.packages?.['']?.devDependencies }
  const missing = []
  for (const name of Object.keys(declared)) {
    if (!(name in lockRoot) || !lock.packages?.[`node_modules/${name}`]) missing.push(name)
  }
  const evidence = [
    `package.json 声明 ${Object.keys(declared).length} 个依赖，锁文件根节点记录 ${Object.keys(lockRoot).length} 个`
  ]
  if (missing.length) {
    evidence.unshift(`声明了但锁定里没有：${missing.join('、')}`)
    console.log(`\n!! 当场点出：${missing.join('、')} 写在 package.json 里却不在 package-lock.json 中`)
  } else {
    evidence.push('声明的每个依赖都能在锁文件中找到对应条目')
  }
  record('deps-declared-not-locked', '依赖声明与锁定对照（声明了没锁定的当场点出）', missing.length ? 'fail' : 'pass', evidence)
  return { pkg, lock }
}

/* ---------- 02 声明 / 锁定 / 实际安装三方一致 ---------- */
function checkLockVsInstalled(lock) {
  const evidence = []
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    try {
      run('npm', ['ci'])
      evidence.push('node_modules 不存在，已按锁文件执行 npm ci')
    } catch (err) {
      return record('lock-vs-installed', '声明 / 锁定 / 实际安装是否同一套', 'fail', [...evidence, `npm ci 失败：${err.message}`])
    }
  }
  const mismatches = []
  const missing = []
  let compared = 0
  for (const key of Object.keys(lock.packages ?? {})) {
    if (!key.startsWith('node_modules/')) continue
    const name = key.slice('node_modules/'.length)
    if (name.includes('/')) continue // 只看顶层安装结果
    const lockedEntry = lock.packages[key]
    // 平台限定包（如 darwin 专用的 fsevents）在本平台本就不该安装，跳过
    if (Array.isArray(lockedEntry.os) && lockedEntry.os.length && !lockedEntry.os.includes(process.platform)) continue
    const installedFile = path.join(ROOT, 'node_modules', name, 'package.json')
    if (!fs.existsSync(installedFile)) {
      missing.push(name)
      continue
    }
    const installed = readJson(installedFile).version
    const locked = lockedEntry.version
    compared += 1
    if (installed !== locked) mismatches.push(`${name}: 锁定 ${locked} ≠ 实装 ${installed}`)
  }
  const extraneous = []
  const modulesDir = path.join(ROOT, 'node_modules')
  for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue // .bin 与 .vite-temp 等工具缓存目录不是依赖
    const names = entry.name.startsWith('@')
      ? fs.readdirSync(path.join(modulesDir, entry.name)).map((sub) => `${entry.name}/${sub}`)
      : [entry.name]
    for (const name of names) {
      if (!lock.packages?.[`node_modules/${name}`]) extraneous.push(name)
    }
  }
  evidence.push(`按锁文件逐个比对顶层依赖 ${compared} 个`)
  if (missing.length) evidence.push(`锁定有但未安装：${missing.join('、')}`)
  if (mismatches.length) evidence.push(...mismatches)
  if (extraneous.length) evidence.push(`多装了锁定里没有的：${extraneous.join('、')}`)
  if (!missing.length && !mismatches.length && !extraneous.length) evidence.push('声明、锁定、实装三方为同一套')
  record(
    'lock-vs-installed',
    '声明 / 锁定 / 实际安装是否同一套',
    missing.length || mismatches.length || extraneous.length ? 'fail' : 'pass',
    evidence
  )
}

/* ---------- 03 构建，报体积与文件数 ---------- */
function checkBuild() {
  const evidence = []
  buildStartedAt = Date.now()
  try {
    const out = run('npm', ['run', 'build'], { maxBuffer: 64 * 1024 * 1024 })
    const lines = out.trim().split('\n').filter((l) => l.trim())
    evidence.push(`构建命令 npm run build 成功（${lines[lines.length - 1] ?? ''}）`)
  } catch (err) {
    return record('build-size', '构建产物体积与文件数', 'fail', [`npm run build 失败：${err.stderr || err.message}`])
  }
  const files = walk(DIST)
  const bytes = files.reduce((sum, f) => sum + fs.statSync(f.full).size, 0)
  evidence.push(`dist/ 共 ${files.length} 个文件，合计 ${(bytes / 1024).toFixed(1)} KB`)
  if (!files.length) return record('build-size', '构建产物体积与文件数', 'fail', [...evidence, 'dist/ 为空'])
  record('build-size', '构建产物体积与文件数', 'pass', evidence)
  return { files, bytes }
}

/* ---------- 04 包内卫生：名单类文件与残留 ---------- */
const ROSTER_EXT = ['.xlsx', '.xls', '.csv', '.tsv', '.numbers', '.et']
const ROSTER_NAME = /(名单|花名册|roster|measurements?)/i
const FORBIDDEN_DIRS = new Set(['src', 'node_modules', '.git'])

function checkPackageHygiene() {
  const files = walk(DIST)
  const hits = []
  for (const file of files) {
    const segments = file.rel.split('/')
    const base = segments[segments.length - 1]
    if (file.rel === REPORT_NAME) continue // 关卡自己产出的机读结论，允许在包内
    const ext = path.extname(base).toLowerCase()
    if (ROSTER_EXT.includes(ext)) hits.push(`${file.rel}（表格 / 逗号分隔文本，疑似名单或下单表）`)
    else if (ROSTER_NAME.test(base)) hits.push(`${file.rel}（文件名疑似名单类）`)
    else if (segments.some((s) => FORBIDDEN_DIRS.has(s))) hits.push(`${file.rel}（源码 / 依赖目录混入）`)
    else if (base === '.env' || base.startsWith('.env.') || ext === '.log') hits.push(`${file.rel}（环境文件 / 日志）`)
    else if (buildStartedAt && fs.statSync(file.full).mtimeMs < buildStartedAt - 2000)
      hits.push(`${file.rel}（mtime 早于本次构建，疑似上次构建残留）`)
  }
  const evidence = [`扫描 dist/ 共 ${files.length} 个文件`]
  if (hits.length) evidence.push(`命中 ${hits.length} 项：${hits.join('；')}`)
  else evidence.push('无表格 / CSV / 源码目录 / 依赖目录 / 环境文件 / 上次构建残留')
  record('package-hygiene', '包内名单类文件与构建残留扫描', hits.length ? 'fail' : 'pass', evidence)
}

/* ---------- 05 内容指纹与缓存期限 ---------- */
function checkAssetFingerprint() {
  const evidence = []
  const indexFile = path.join(DIST, 'index.html')
  if (!fs.existsSync(indexFile)) return record('asset-fingerprint-cache', '内容指纹与缓存期限', 'fail', ['dist/index.html 不存在'])
  const html = fs.readFileSync(indexFile, 'utf8')
  const refs = [...html.matchAll(/(?:src|href)="(\/?assets\/[^"]+)"/g)].map((m) => m[1])
  const noHash = refs.filter((ref) => !/-[0-9A-Za-z_-]{8,}\.[\w]+$/.test(ref))
  const missing = refs.filter((ref) => !fs.existsSync(path.join(DIST, ref.replace(/^\//, ''))))
  evidence.push(`index.html 引用 ${refs.length} 个静态资源：${refs.join('、') || '（无）'}`)
  if (noHash.length) evidence.push(`文件名不含内容指纹：${noHash.join('、')}`)
  else if (refs.length) evidence.push('全部带版本号文件名均含内容指纹（name-hash.ext）')
  if (missing.length) evidence.push(`引用了但包里没有：${missing.join('、')}`)

  const nginx = fs.readFileSync(path.join(ROOT, 'nginx.conf'), 'utf8')
  const assetsBlock = /location\s+\/assets\/\s*\{[^}]*\}/s.exec(nginx)?.[0] ?? ''
  const indexBlock = /location\s*=\s*\/index\.html\s*\{[^}]*\}/s.exec(nginx)?.[0] ?? ''
  const assetsOk = /immutable/.test(assetsBlock) && /max-age=(\d+)/.test(assetsBlock) && Number(/max-age=(\d+)/.exec(assetsBlock)[1]) >= 31536000
  const indexOk = /no-cache/.test(indexBlock) || /no-store/.test(indexBlock)
  evidence.push(
    assetsOk
      ? '指纹资源（/assets/）：允许缓存 1 年且 immutable（内容变了指纹就变，安全）'
      : '指纹资源（/assets/）未配置长期 immutable 缓存'
  )
  evidence.push(indexOk ? '首页 index.html：no-cache/no-store，发版即时生效' : '首页 index.html 未禁止缓存')
  const failed = noHash.length > 0 || missing.length > 0 || !assetsOk || !indexOk
  record('asset-fingerprint-cache', '带版本号文件名的内容指纹与缓存期限', failed ? 'fail' : 'pass', evidence)
}

/* ---------- 06 容器：端口与探活 ---------- */
function checkContainerStatic() {
  const evidence = []
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
  const nginx = fs.readFileSync(path.join(ROOT, 'nginx.conf'), 'utf8')
  const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8')

  const expose = /EXPOSE\s+(\d+)/.exec(dockerfile)?.[1]
  const listen = /listen\s+(\d+)/.exec(nginx)?.[1]
  const portMap = /["']?(\d+):(\d+)["']?/.exec(compose)
  const problems = []
  evidence.push(`Dockerfile EXPOSE ${expose ?? '未声明'}；nginx listen ${listen ?? '未配置'}；compose 端口映射 ${portMap ? `${portMap[1]}:${portMap[2]}` : '未配置'}`)
  if (!expose || !listen || !portMap) problems.push('端口声明不完整')
  else if (expose !== listen || portMap[2] !== listen)
    problems.push(`对外映射的容器侧端口 ${portMap[2]} 与实际监听 ${listen}（EXPOSE ${expose}）不一致`)
  else evidence.push(`对外写的 ${portMap[1]}:${portMap[2]} 与容器内实际监听 ${listen} 是同一个端口`)

  const healthPath = /location\s*=\s*(\/healthz)/.test(nginx) ? '/healthz' : null
  // nginx 配置里的 "ok\n" 是转义写法，解析后应答体为真实换行，这里按同样规则还原再比对
  const healthBodyRaw = /return\s+200\s+"([^"]*)"/.exec(nginx)?.[1]
  const healthBody = healthBodyRaw?.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\\\/g, '\\')
  const dockerHealth = /HEALTHCHECK[\s\S]*?\/healthz/.test(dockerfile)
  const composeHealth = /healthcheck[\s\S]*?\/healthz/.test(compose)
  evidence.push(`探活地址 ${healthPath ?? '未配置'}，应答内容 ${JSON.stringify(healthBody ?? '')}；Dockerfile HEALTHCHECK ${dockerHealth ? '已配' : '缺失'}，compose healthcheck ${composeHealth ? '已配' : '缺失'}`)
  if (!healthPath || healthBody !== 'ok\n' || !dockerHealth || !composeHealth)
    problems.push('探活地址或应答内容（应为 200 "ok"）配置不完整')
  record('container-config-consistency', '容器端口与探活配置一致性（静态）', problems.length ? 'fail' : 'pass', [...evidence, ...problems])
}

async function checkContainerRuntime() {
  let hasDocker = true
  try {
    run('docker', ['--version'])
  } catch {
    hasDocker = false
  }
  if (!hasDocker) {
    record(
      'container-runtime-probe',
      '容器运行时探活（起容器请求 /healthz 与对外端口）',
      'skip',
      [],
      '本机没有 docker CLI，无法实际起容器；已用上一项静态核对替代，部署机上需补跑 docker compose up 后 curl /healthz'
    )
    return
  }
  const evidence = []
  try {
    run('docker', ['compose', 'up', '-d', '--build'])
    const portMap = /["']?(\d+):(\d+)["']?/.exec(fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8'))
    const body = run('curl', ['-fsS', `http://127.0.0.1:${portMap[1]}/healthz`])
    evidence.push(`GET /healthz → ${JSON.stringify(body)}`)
    record('container-runtime-probe', '容器运行时探活', body === 'ok\n' ? 'pass' : 'fail', evidence)
  } catch (err) {
    record('container-runtime-probe', '容器运行时探活', 'fail', [...evidence, String(err.message)])
  } finally {
    try {
      run('docker', ['compose', 'down'])
    } catch {
      /* 忽略清理失败 */
    }
  }
}

/* ---------- 07 带编号的地址刷新后是否回到同一页 ---------- */
async function checkSpaRoutes() {
  const nginx = fs.readFileSync(path.join(ROOT, 'nginx.conf'), 'utf8')
  const hasFallback = /try_files\s+\$uri\s+\$uri\/\s+\/index\.html/.test(nginx)
  const staticEvidence = hasFallback
    ? 'nginx.conf 已配 SPA 回退 try_files $uri $uri/ /index.html'
    : 'nginx.conf 缺少 SPA 回退，带编号地址刷新会 404'

  const routes = ['/measure/GATE001', '/import/GATE001', '/merge/GATE001', '/summary/GATE001', '/export/GATE001']
  const evidence = [staticEvidence]
  let samePage = null
  const viteBin = path.join(ROOT, 'node_modules', '.bin', 'vite')
  if (!fs.existsSync(viteBin) || !fs.existsSync(DIST)) {
    record('spa-route-refresh', '带编号地址刷新回到同一页', 'skip', evidence, '本机未安装依赖或无构建产物，无法起静态服务实测带编号地址')
    return
  }
  const server = spawn(viteBin, ['preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], { cwd: ROOT })
  try {
    const base = 'http://127.0.0.1:4173'
    let home = null
    for (let i = 0; i < 50 && home === null; i += 1) {
      await new Promise((r) => setTimeout(r, 200))
      home = await fetch(`${base}/`).then((r) => (r.ok ? r.text() : null)).catch(() => null)
    }
    if (home === null) throw new Error('vite preview 未在 10 秒内就绪')
    samePage = true
    for (const route of routes) {
      const res = await fetch(`${base}${route}`)
      const body = await res.text()
      const same = res.ok && body === home
      samePage = samePage && same
      evidence.push(`GET ${route} → ${res.status}，${same ? '与首页同一份 index.html' : '未回到同一页'}`)
    }
    evidence.push('以 vite preview 对构建产物实测（docker 不在本机，nginx 行为以静态核对为准）')
  } catch (err) {
    evidence.push(`运行时探测失败：${err.message}`)
    samePage = false
  } finally {
    server.kill()
  }
  record('spa-route-refresh', '带编号地址刷新回到同一页', hasFallback && samePage ? 'pass' : 'fail', evidence)
}

/* ---------- 08 构建上下文必须排除的目录 ---------- */
function parseDockerignore() {
  const file = path.join(ROOT, '.dockerignore')
  if (!fs.existsSync(file)) return null
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

function dockerignoreMatch(rel, patterns) {
  for (const pattern of patterns) {
    const neg = pattern.startsWith('!')
    const p = neg ? pattern.slice(1) : pattern
    const dirOnly = p.endsWith('/')
    const core = p.replace(/\/+$/, '')
    let hit = false
    if (core.includes('*')) {
      const re = new RegExp(
        `^${core.split('/').map((seg) => seg === '**' ? '.*' : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('/')}$`
      )
      hit = re.test(rel) || re.test(rel.split('/').pop())
    } else {
      hit = rel === core || rel.startsWith(`${core}/`) || rel.split('/').includes(core)
    }
    if (hit && !neg) return true
    if (hit && neg) return false
  }
  return false
}

function checkBuildContext() {
  const patterns = parseDockerignore()
  if (!patterns) {
    return record(
      'build-context-excludes',
      '构建上下文必须排除的目录（.dockerignore）',
      'fail',
      ['缺少 .dockerignore：node_modules、dist、.git、.env、名单类数据都会被原样送进构建上下文']
    )
  }
  const evidence = [`.dockerignore 共 ${patterns.length} 条规则`]
  const required = {
    'node_modules': (p) => p === 'node_modules' || p === 'node_modules/',
    'dist': (p) => p === 'dist' || p === 'dist/',
    '.git': (p) => p === '.git' || p === '.git/',
    '.env 类': (p) => p === '.env' || p === '.env.*',
    '*.log': (p) => p === '*.log',
    '名单类数据（csv/xlsx/data/samples/exports 任一）': (p) =>
      /(^|\/)data\/?$/.test(p) || /(^|\/)samples\/?$/.test(p) || /(^|\/)exports\/?$/.test(p) || p === '*.csv' || p === '**/*.csv' || p === '*.xlsx' || p === '**/*.xlsx'
  }
  const missing = Object.entries(required).filter(([, test]) => !patterns.some(test)).map(([name]) => name)

  const contextFiles = walk(ROOT).filter((f) => {
    const rel = f.rel
    if (rel.startsWith('.git/') || rel.startsWith('node_modules/') || rel.startsWith('dist/')) return false
    if (rel.startsWith('.gate-')) return false
    return true
  })
  const rosterInContext = contextFiles.filter((f) => {
    const base = f.rel.split('/').pop()
    return ROSTER_EXT.includes(path.extname(base).toLowerCase()) || ROSTER_NAME.test(base)
  })
  const uncovered = rosterInContext.filter((f) => !dockerignoreMatch(f.rel, patterns))
  const shipped = contextFiles.filter((f) => !dockerignoreMatch(f.rel, patterns))
  const shippedBytes = shipped.reduce((sum, f) => sum + fs.statSync(f.full).size, 0)
  evidence.push(`排除后构建上下文约 ${(shippedBytes / 1024).toFixed(1)} KB / ${shipped.length} 个文件（上限 5 MB）`)
  if (rosterInContext.length)
    evidence.push(`上下文内名单类文件 ${rosterInContext.length} 个：${rosterInContext.map((f) => f.rel).join('、')}（${uncovered.length ? '有未被排除的！' : '均已被 .dockerignore 排除'}）`)
  else evidence.push('上下文内未发现名单类文件（表格 / CSV / 名单命名）')
  if (missing.length) evidence.push(`.dockerignore 缺少必需项：${missing.join('、')}`)
  if (uncovered.length) evidence.push(`未被排除的名单类文件：${uncovered.map((f) => f.rel).join('、')}`)
  if (shippedBytes > CONTEXT_SIZE_LIMIT) evidence.push('构建上下文超过 5 MB')
  const failed = missing.length > 0 || uncovered.length > 0 || shippedBytes > CONTEXT_SIZE_LIMIT
  record('build-context-excludes', '构建上下文必须排除的目录（.dockerignore）', failed ? 'fail' : 'pass', evidence)
}

/* ---------- 09 同一提交连续打包两次的一致性 ---------- */
function snapshot(dir) {
  const map = new Map()
  for (const f of walk(dir)) map.set(f.rel, fs.statSync(f.full).size)
  return map
}

function checkRebuildDeterminism() {
  const evidence = []
  fs.rmSync(REBUILD_DIR, { recursive: true, force: true })
  try {
    // dist/ 由第 03 项构建产出且此后无人改动；这里只把同一份源码再构建到对照目录
    run('npm', ['run', 'build', '--', '--outDir', path.basename(REBUILD_DIR), '--emptyOutDir'], { maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    return record('rebuild-determinism', '同一提交连续打包两次的一致性', 'fail', [`第二次构建失败：${err.message}`])
  }
  const a = snapshot(DIST)
  const b = snapshot(REBUILD_DIR)
  fs.rmSync(REBUILD_DIR, { recursive: true, force: true })
  const onlyA = [...a.keys()].filter((k) => !b.has(k))
  const onlyB = [...b.keys()].filter((k) => !a.has(k))
  const sizeDiff = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k))
  const totalA = [...a.values()].reduce((s, v) => s + v, 0)
  evidence.push(`第一次 ${a.size} 个文件 / ${(totalA / 1024).toFixed(1)} KB；第二次 ${b.size} 个文件`)
  if (!onlyA.length && !onlyB.length && !sizeDiff.length) {
    evidence.push('两次构建的文件清单与逐文件体积标记完全一致')
  } else {
    if (onlyA.length) evidence.push(`仅第一次有：${onlyA.join('、')}`)
    if (onlyB.length) evidence.push(`仅第二次有：${onlyB.join('、')}`)
    if (sizeDiff.length) evidence.push(`体积不一致：${sizeDiff.join('、')}`)
  }
  record('rebuild-determinism', '同一提交连续打包两次的一致性', onlyA.length || onlyB.length || sizeDiff.length ? 'fail' : 'pass', evidence)
}

/* ---------- 汇总产出 ---------- */
async function main() {
  console.log(`交付关卡启动（模式：${MODE === 'enforce' ? '硬拦——任一不过即打包失败' : '只出报告'}）`)
  const { lock } = checkDeclaredNotLocked()
  checkLockVsInstalled(lock)
  checkBuild()
  checkPackageHygiene()
  checkAssetFingerprint()
  checkContainerStatic()
  await checkContainerRuntime()
  await checkSpaRoutes()
  checkBuildContext()
  checkRebuildDeterminism()

  const failed = checks.filter((c) => c.status === 'fail')
  const skipped = checks.filter((c) => c.status === 'skip')
  const report = {
    schema: 'delivery-gate/v1',
    app: 'app-030',
    commit: gitCommit(),
    generatedAt: new Date().toISOString(),
    mode: MODE,
    overall: failed.length ? 'fail' : 'pass',
    policy: {
      sampleData: 'strip-all',
      sampleDataRule:
        '包里一律不留示例量体数据；演示靠现场新建项目手工录入或导入自己的文件。唯一随包的数据文件是 src/data/size-rules.json（号型规则表，不含个人信息）。凡含真实姓名 / 班级 / 身体尺寸、或来源无法证明为合成数据的文件，必须剥干净。',
      hardBlockRule:
        '默认硬拦：任一检查不过，打包命令以非零退出，不得继续 docker build。仅当本机缺工具导致跳过、或临时出演示包时，可用 --report-only 降级为只出报告，且报告必须随包留档、由人签字确认。名单类文件命中、声明与锁定不一致两项永远硬拦，无豁免。'
    },
    checks
  }

  fs.mkdirSync(PUBLIC_DIR, { recursive: true })
  for (const target of [path.join(PUBLIC_DIR, REPORT_NAME), path.join(DIST, REPORT_NAME)]) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n')
  }

  console.log('\n========== 关卡结论 ==========')
  console.log(`总体：${report.overall === 'pass' ? '过' : '不过'}（${checks.length - failed.length - skipped.length} 过 / ${failed.length} 不过 / ${skipped.length} 跳过）`)
  for (const c of failed) console.log(`  不过：${c.title} —— ${c.evidence[c.evidence.length - 1]}`)
  for (const c of skipped) console.log(`  跳过：${c.title} —— ${c.skipReason}`)
  console.log(`机读结论已写入 public/${REPORT_NAME} 与 dist/${REPORT_NAME}（页面、导出说明、打包侧三方共读此文件）`)

  if (MODE === 'enforce' && failed.length) {
    console.error('\n硬拦生效：存在不过项，打包终止。临时出包请加 --report-only（结论仍会写入报告）。')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`关卡自身执行失败：${err.stack || err}`)
  process.exit(2)
})
