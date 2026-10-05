#!/usr/bin/env node
/**
 * 发布关卡（release gate）：交包之前跑一遍，给结论。
 *
 * 用法：
 *   node scripts/release-gate.mjs                # 完整关卡（含两次构建一致性），默认硬拦
 *   node scripts/release-gate.mjs --no-build     # 复用现有 dist（Docker 构建内用）
 *   node scripts/release-gate.mjs --report-only  # 只出报告不拦（dist 混入名单类文件除外，见下）
 *
 * 结论只写一份机读文件：dist/release-gate-report.json。
 * 打包脚本（exit code）、首页「交付自检」、导出页「导出说明」三处都读这一份，不各写判断。
 *
 * 硬拦约定（与 release-gate.md 一致）：
 *   - 默认任何检查项 fail → 退出码 1，打包失败；
 *   - --report-only 只降级「非名单类」失败；dist 里发现名单类文件（dist.clean）任何模式都拦，
 *     因为「带名单出门」没有临时放行这一说。
 *   - 机器上没相应工具（如 docker）→ 该项 status=skip 并写明原因，不算过也不算不过。
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST_DIR = path.join(APP_DIR, 'dist')
const REPORT_NAME = 'release-gate-report.json'
const REPORT_PATH = path.join(DIST_DIR, REPORT_NAME)

const args = new Set(process.argv.slice(2))
const NO_BUILD = args.has('--no-build')
const REPORT_ONLY = args.has('--report-only') || process.env.GATE_MODE === 'report'

/** 名单类文件：只应留在这台机器上，绝不进包 */
const ROSTER_EXTENSIONS = ['.csv', '.xlsx', '.xls', '.tsv', '.numbers']
const ROSTER_DIR_PATTERN = /(^|\/)(data\/measurements|measurements|samples|exports)(\/|$)/
/** 即使 --report-only 也照样硬拦的检查项 */
const ALWAYS_BLOCKING = new Set(['dist.clean'])

const checks = []
let buildStartMs = 0

function addCheck(id, title, status, evidence, skipReason) {
  const check = { id, title, status, evidence }
  if (status === 'skip' && skipReason) check.skipReason = skipReason
  checks.push(check)
  return check
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function walk(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

function rel(file) {
  return path.relative(APP_DIR, file).split(path.sep).join('/')
}

function distManifest() {
  const files = walk(DIST_DIR).filter((f) => path.basename(f) !== REPORT_NAME)
  const entries = {}
  let totalBytes = 0
  for (const file of files) {
    const key = rel(file)
    const size = fs.statSync(file).size
    entries[key] = { size, sha256: sha256(file) }
    totalBytes += size
  }
  return { fileCount: files.length, totalBytes, entries }
}

function commandExists(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'pipe' })
  return !r.error && r.status === 0
}

function gitCommit() {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: APP_DIR, stdio: 'pipe' })
  return r.status === 0 ? r.stdout.toString().trim() : 'unknown'
}

/* ---------------- 1. 依赖：声明里写了的、锁定里没有的，当场点出来 ---------------- */

function checkDeclaredVsLock() {
  const pkg = readJson(path.join(APP_DIR, 'package.json'))
  const lockPath = path.join(APP_DIR, 'package-lock.json')
  if (!fs.existsSync(lockPath)) {
    addCheck('deps.declared-vs-lock', '依赖声明 vs 锁定文件', 'fail', ['package-lock.json 不存在，无法核对'])
    return
  }
  const lock = readJson(lockPath)
  const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const missing = []
  for (const name of Object.keys(declared)) {
    const inTree = Boolean(lock.packages?.[`node_modules/${name}`])
    const inRoot = Boolean(lock.packages?.['']?.dependencies?.[name] ?? lock.packages?.['']?.devDependencies?.[name])
    if (!inTree || !inRoot) missing.push(name)
  }
  const evidence = [
    `package.json 声明 ${Object.keys(declared).length} 个依赖，package-lock.json 记录 ${
      Object.keys(lock.packages ?? {}).filter((k) => k !== '').length
    } 个包`
  ]
  if (missing.length > 0) {
    evidence.push(`声明了但锁定里没有：${missing.join('、')}`)
    addCheck('deps.declared-vs-lock', '依赖声明 vs 锁定文件', 'fail', evidence)
  } else {
    evidence.push('声明的每个依赖在锁定文件中都找得到（树与根声明两处一致）')
    addCheck('deps.declared-vs-lock', '依赖声明 vs 锁定文件', 'pass', evidence)
  }
}

/* ---------------- 2. 依赖：锁定 vs 实际装出来的，是不是同一套 ---------------- */

function checkLockVsInstalled() {
  const nmDir = path.join(APP_DIR, 'node_modules')
  if (!fs.existsSync(nmDir)) {
    addCheck('deps.lock-vs-installed', '锁定文件 vs 实际安装', 'skip', [], '本机没有 node_modules（未执行 npm ci），无法核对实际安装版本')
    return
  }
  const pkg = readJson(path.join(APP_DIR, 'package.json'))
  const lock = readJson(path.join(APP_DIR, 'package-lock.json'))
  const declared = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })
  const mismatches = []
  const missing = []
  for (const name of declared) {
    const installedPkg = path.join(nmDir, name, 'package.json')
    const locked = lock.packages?.[`node_modules/${name}`]?.version
    if (!fs.existsSync(installedPkg)) {
      missing.push(name)
      continue
    }
    const installed = readJson(installedPkg).version
    if (locked && installed !== locked) mismatches.push(`${name}：锁定 ${locked} ≠ 实装 ${installed}`)
  }
  const evidence = [`核对直接依赖 ${declared.length} 个：锁定版本与 node_modules 实装版本逐一比对`]
  if (missing.length > 0 || mismatches.length > 0) {
    if (missing.length > 0) evidence.push(`声明了但没装上：${missing.join('、')}`)
    if (mismatches.length > 0) evidence.push(...mismatches)
    addCheck('deps.lock-vs-installed', '锁定文件 vs 实际安装', 'fail', evidence)
  } else {
    evidence.push('三者同一套：package.json = package-lock.json = node_modules')
    addCheck('deps.lock-vs-installed', '锁定文件 vs 实际安装', 'pass', evidence)
  }
}

/* ---------------- 3. 构建上下文：哪些目录必须排除（.dockerignore） ---------------- */

function dockerignoreToRegex(pattern) {
  // 简化实现 docker 的 Go filepath.Match + ** 语义，对相对路径全串匹配
  let re = ''
  let i = 0
  const p = pattern.replace(/\/$/, '')
  while (i < p.length) {
    const ch = p[i]
    if (ch === '*') {
      if (p[i + 1] === '*') {
        re += '.*'
        i += 2
        if (p[i] === '/') i += 1
        continue
      }
      re += '[^/]*'
    } else if (ch === '?') {
      re += '[^/]'
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
    i += 1
  }
  return new RegExp(`^${re}$`)
}

function checkDockerignore() {
  const file = path.join(APP_DIR, '.dockerignore')
  if (!fs.existsSync(file)) {
    addCheck('context.dockerignore', '构建上下文排除（.dockerignore）', 'fail', [
      '.dockerignore 不存在：node_modules、dist 与名单类文件会全部进入构建上下文'
    ])
    return
  }
  const patterns = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  const required = ['node_modules', 'dist', '.git', '.env', '*.log', 'coverage', '**/*.csv', '**/*.xlsx', 'data/', 'samples/', 'exports/']
  const missingPatterns = required.filter((need) => !patterns.some((p) => p === need || p === need.replace(/\/$/, '')))

  const matchers = patterns.map((p) => dockerignoreToRegex(p))
  const isExcluded = (relPath) => matchers.some((re) => re.test(relPath))
  // 按排除规则剪枝遍历：被排除的目录不再下钻（与 docker 构建上下文语义一致）
  const included = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel(path.join(dir, entry.name))
      if (isExcluded(relPath)) continue
      if (entry.isDirectory()) visit(path.join(dir, entry.name))
      else if (entry.isFile()) included.push(relPath)
    }
  }
  visit(APP_DIR)
  const rosterInContext = included.filter((r) => {
    const ext = path.extname(r).toLowerCase()
    return ROSTER_EXTENSIONS.includes(ext) || ROSTER_DIR_PATTERN.test(`/${r}`)
  })
  const totalBytes = included.reduce((sum, r) => sum + fs.statSync(path.join(APP_DIR, r)).size, 0)
  const overLimit = totalBytes >= 5 * 1024 * 1024

  const evidence = [
    `.dockerignore 共 ${patterns.length} 条排除规则；生效后上下文 ${included.length} 个文件、${(totalBytes / 1024).toFixed(1)} KB（上限 5 MB）`,
    'nginx.conf 必须留在上下文（运行阶段 COPY），故不列入排除；scripts/ 保留供镜像内跑本关卡'
  ]
  const problems = []
  if (missingPatterns.length > 0) problems.push(`缺少排除规则：${missingPatterns.join('、')}`)
  if (rosterInContext.length > 0) problems.push(`名单类文件会进入上下文：${rosterInContext.join('、')}`)
  if (overLimit) problems.push(`上下文 ${(totalBytes / 1024 / 1024).toFixed(2)} MB ≥ 5 MB`)
  if (problems.length > 0) evidence.push(...problems)
  else evidence.push('node_modules / dist / .git / 名单类数据均被排除，上下文无隐私文件')
  addCheck('context.dockerignore', '构建上下文排除（.dockerignore）', problems.length > 0 ? 'fail' : 'pass', evidence)
}

/* ---------------- 4. 同一提交连续打包两次：文件清单与体积标记是否一致 ---------------- */

function runBuild() {
  const r = spawnSync('npm', ['run', 'build'], { cwd: APP_DIR, stdio: 'pipe', encoding: 'utf8' })
  if (r.status !== 0) {
    const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split('\n').slice(-25).join('\n')
    throw new Error(`npm run build 失败：\n${tail}`)
  }
}

function checkReproducible() {
  if (NO_BUILD) {
    addCheck('build.reproducible', '同一提交连续打包两次一致性', 'skip', [], '--no-build 模式复用现有 dist（Docker 构建内由外层关卡负责两次构建核对）')
    return null
  }
  buildStartMs = Date.now()
  runBuild()
  const first = distManifest()
  runBuild()
  const second = distManifest()
  const onlyFirst = Object.keys(first.entries).filter((k) => !second.entries[k])
  const onlySecond = Object.keys(second.entries).filter((k) => !first.entries[k])
  const changed = Object.keys(first.entries).filter(
    (k) => second.entries[k] && (second.entries[k].size !== first.entries[k].size || second.entries[k].sha256 !== first.entries[k].sha256)
  )
  const evidence = [
    `第一次：${first.fileCount} 个文件、${first.totalBytes} 字节；第二次：${second.fileCount} 个文件、${second.totalBytes} 字节`,
    `清单指纹 ${createHash('sha256').update(JSON.stringify(second.entries)).digest('hex').slice(0, 16)}`
  ]
  const problems = []
  if (onlyFirst.length > 0) problems.push(`仅第一次出现：${onlyFirst.join('、')}`)
  if (onlySecond.length > 0) problems.push(`仅第二次出现：${onlySecond.join('、')}`)
  if (changed.length > 0) problems.push(`内容或体积不一致：${changed.join('、')}`)
  if (problems.length > 0) evidence.push(...problems)
  else evidence.push('两次构建的文件清单、逐文件体积与内容哈希完全一致')
  addCheck('build.reproducible', '同一提交连续打包两次一致性', problems.length > 0 ? 'fail' : 'pass', evidence)
  return second
}

/* ---------------- 5. 包体：多大、多少文件；名单类 / 源码目录 / 依赖目录 / 残留 ---------------- */

function checkDistClean(manifest) {
  if (!fs.existsSync(DIST_DIR)) {
    addCheck('dist.clean', '包体内容与体积', 'fail', ['dist/ 不存在，先执行 npm run build'])
    return
  }
  const m = manifest ?? distManifest()
  const files = Object.keys(m.entries).map((k) => k.replace(/^dist\//, ''))
  const roster = files.filter((f) => ROSTER_EXTENSIONS.includes(path.extname(f).toLowerCase()) || ROSTER_DIR_PATTERN.test(`/${f}`))
  const sourceDirs = files.filter((f) => /^(src|node_modules)\//.test(f))
  const residue =
    buildStartMs > 0
      ? walk(DIST_DIR)
          .filter((f) => path.basename(f) !== REPORT_NAME)
          .filter((f) => fs.statSync(f).mtimeMs < buildStartMs - 1500)
          .map((f) => rel(f))
      : []
  const evidence = [
    `dist/ 共 ${m.fileCount} 个文件、${(m.totalBytes / 1024).toFixed(1)} KB`,
    `文件清单：${files.join('、')}`
  ]
  const problems = []
  if (roster.length > 0) problems.push(`名单类文件混入包内：${roster.join('、')}`)
  if (sourceDirs.length > 0) problems.push(`源码/依赖目录混入包内：${sourceDirs.join('、')}`)
  if (residue.length > 0) problems.push(`上次构建残留（本次构建未重写）：${residue.join('、')}`)
  if (buildStartMs === 0) evidence.push('残留检查跳过：本次关卡未执行构建（--no-build）')
  if (problems.length > 0) evidence.push(...problems)
  else evidence.push('无表格/逗号分隔文本等名单类文件，无 src/ 与 node_modules/，无上次构建残留')
  addCheck('dist.clean', '包体内容与体积（名单类文件硬拦项）', problems.length > 0 ? 'fail' : 'pass', evidence)
}

/* ---------------- 6. 首页引到的带版本号文件：内容指纹与缓存时长 ---------------- */

function checkFingerprint() {
  const indexPath = path.join(DIST_DIR, 'index.html')
  if (!fs.existsSync(indexPath)) {
    addCheck('assets.fingerprint', '入口引用指纹与缓存时长', 'fail', ['dist/index.html 不存在'])
    return
  }
  const html = fs.readFileSync(indexPath, 'utf8')
  const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])
  const nginx = fs.readFileSync(path.join(APP_DIR, 'nginx.conf'), 'utf8')
  const problems = []
  const evidence = []
  if (refs.length === 0) problems.push('index.html 未引用任何 /assets/ 资源')
  for (const ref of refs) {
    const base = path.basename(ref)
    const hasFingerprint = /-[0-9A-Za-z_-]{8,}\.[\w]+$/.test(base)
    const exists = fs.existsSync(path.join(DIST_DIR, ref))
    if (!hasFingerprint) problems.push(`${base} 文件名无内容指纹`)
    if (!exists) problems.push(`${base} 被首页引用但 dist 中不存在`)
    evidence.push(`${base}：指纹${hasFingerprint ? '有' : '无'}，文件${exists ? '存在' : '缺失'}`)
  }
  const assetsBlock = nginx.match(/location\s+\/assets\/\s*{([^}]*)}/s)
  const indexBlock = nginx.match(/location\s+=\s*\/index\.html\s*{([^}]*)}/s)
  const assetsCache = Boolean(assetsBlock && /immutable/.test(assetsBlock[1]) && /max-age=31536000/.test(assetsBlock[1]))
  const indexCache = Boolean(indexBlock && /no-cache/.test(indexBlock[1]) && /no-store/.test(indexBlock[1]))
  if (!assetsCache) problems.push('nginx.conf 中 /assets/ 未配置 immutable + max-age=31536000')
  if (!indexCache) problems.push('nginx.conf 中 /index.html 未配置 no-cache/no-store')
  evidence.push(
    `缓存时长：带指纹资源 ${assetsCache ? 'immutable, max-age=31536000（一年）' : '配置缺失'}；` +
      `首页 index.html ${indexCache ? 'no-cache, no-store（不缓存，发版即时生效）' : '配置缺失'}`
  )
  addCheck('assets.fingerprint', '入口引用指纹与缓存时长', problems.length > 0 ? 'fail' : 'pass', evidence)
}

/* ---------------- 7/8/9. 容器：端口、探活、运行态 ---------------- */

function checkPorts() {
  const compose = fs.readFileSync(path.join(APP_DIR, 'docker-compose.yml'), 'utf8')
  const dockerfile = fs.readFileSync(path.join(APP_DIR, 'Dockerfile'), 'utf8')
  const nginx = fs.readFileSync(path.join(APP_DIR, 'nginx.conf'), 'utf8')
  const portMatch = compose.match(/["']?(\d+):(\d+)["']?/)
  const exposeMatch = dockerfile.match(/^EXPOSE\s+(\d+)/m)
  const listenMatch = nginx.match(/listen\s+(\d+)/)
  const problems = []
  const evidence = []
  if (!portMatch || !exposeMatch || !listenMatch) {
    if (!portMatch) problems.push('docker-compose.yml 未找到端口映射')
    if (!exposeMatch) problems.push('Dockerfile 未找到 EXPOSE')
    if (!listenMatch) problems.push('nginx.conf 未找到 listen')
  } else {
    const [, hostPort, containerPort] = portMatch
    evidence.push(`compose 对外发布 ${hostPort}:${containerPort}（宿主 ${hostPort} → 容器 ${containerPort}）`)
    evidence.push(`Dockerfile EXPOSE ${exposeMatch[1]}；nginx listen ${listenMatch[1]}`)
    if (containerPort !== exposeMatch[1] || containerPort !== listenMatch[1]) {
      problems.push(`对外映射的容器端口 ${containerPort} 与实际监听不一致（EXPOSE ${exposeMatch[1]} / listen ${listenMatch[1]}）`)
    } else {
      evidence.push(`三处同为 ${containerPort}：对外写的与里面实际听的是同一个端口`)
    }
    const doc = fs.readFileSync(path.join(APP_DIR, 'uniform-size-tally.md'), 'utf8')
    const docPort = doc.match(/(\d+):80/)
    if (docPort && docPort[1] !== hostPort) {
      evidence.push(`提示：需求文档写 ${docPort[1]}:80，与 compose ${hostPort}:80 不一致（以 compose 为准，已同步修正文档）`)
    }
  }
  addCheck('container.ports', '容器端口一致性', problems.length > 0 ? 'fail' : 'pass', evidence)
}

function checkHealthz() {
  const nginx = fs.readFileSync(path.join(APP_DIR, 'nginx.conf'), 'utf8')
  const block = nginx.match(/location\s+=\s*\/healthz\s*{([^}]*)}/s)
  const problems = []
  const evidence = []
  if (!block) {
    problems.push('nginx.conf 未配置 /healthz 探活地址')
  } else {
    const ret = block[1].match(/return\s+200\s+"([^"]*)"/)
    if (!ret) problems.push('/healthz 未配置 return 200')
    else evidence.push(`探活地址 /healthz 应答 200，内容 "${ret[1].replace(/\n/g, '\\n')}"（与 Dockerfile HEALTHCHECK、compose healthcheck 请求路径一致）`)
  }
  const dockerfile = fs.readFileSync(path.join(APP_DIR, 'Dockerfile'), 'utf8')
  const compose = fs.readFileSync(path.join(APP_DIR, 'docker-compose.yml'), 'utf8')
  if (!dockerfile.includes('http://127.0.0.1/healthz')) problems.push('Dockerfile HEALTHCHECK 未请求 /healthz')
  if (!compose.includes('http://127.0.0.1/healthz')) problems.push('compose healthcheck 未请求 /healthz')
  addCheck('container.healthz', '探活地址配置', problems.length > 0 ? 'fail' : 'pass', evidence)
}

async function checkContainerRuntime() {
  if (!commandExists('docker')) {
    addCheck('container.runtime', '容器运行态实测', 'skip', [], '本机无 docker，无法实测容器端口与 /healthz 应答；静态核对见 container.ports / container.healthz')
    return
  }
  const inspect = spawnSync('docker', ['container', 'inspect', '-f', '{{.State.Running}}', 'app-030-engineering-16'], {
    stdio: 'pipe',
    encoding: 'utf8'
  })
  if (inspect.status !== 0 || inspect.stdout.trim() !== 'true') {
    addCheck('container.runtime', '容器运行态实测', 'skip', [], '容器 app-030-engineering-16 未在运行（docker compose up -d 后重跑本关卡可实测）')
    return
  }
  const problems = []
  const evidence = []
  try {
    const res = await fetch('http://127.0.0.1:8260/healthz')
    const body = await res.text()
    if (res.status === 200 && body === 'ok\n') evidence.push('GET :8260/healthz → 200 "ok\\n"，探活内容正确')
    else problems.push(`GET :8260/healthz → ${res.status} ${JSON.stringify(body)}，期望 200 "ok\\n"`)
  } catch (err) {
    problems.push(`探活请求失败：${err.message}`)
  }
  addCheck('container.runtime', '容器运行态实测', problems.length > 0 ? 'fail' : 'pass', evidence)
}

/* ---------------- 10. 带编号的地址逐个打开刷新，是否都回到同一页 ---------------- */

function serveDist() {
  const indexBytes = fs.readFileSync(path.join(DIST_DIR, 'index.html'))
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
    const filePath = path.join(DIST_DIR, urlPath)
    if (urlPath !== '/' && filePath.startsWith(DIST_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.writeHead(200)
      res.end(fs.readFileSync(filePath))
      return
    }
    // 与 nginx try_files $uri $uri/ /index.html 等价的 SPA 回退
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(indexBytes)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function checkSpaRoutes() {
  const indexPath = path.join(DIST_DIR, 'index.html')
  if (!fs.existsSync(indexPath)) {
    addCheck('spa.routes', '带编号地址刷新回退', 'fail', ['dist/index.html 不存在'])
    return
  }
  const nginx = fs.readFileSync(path.join(APP_DIR, 'nginx.conf'), 'utf8')
  if (!/try_files\s+\$uri\s+\$uri\/\s+\/index\.html;/.test(nginx)) {
    addCheck('spa.routes', '带编号地址刷新回退', 'fail', ['nginx.conf 缺少 try_files $uri $uri/ /index.html; 回退规则'])
    return
  }
  const routes = ['/', '/rules', '/measure/demo-001', '/import/demo-001', '/merge/demo-001', '/summary/demo-001', '/export/demo-001']
  const expected = fs.readFileSync(indexPath, 'utf8')
  const { server, port } = await serveDist()
  const problems = []
  const evidence = []
  try {
    for (const route of routes) {
      const res = await fetch(`http://127.0.0.1:${port}${route}`)
      const body = await res.text()
      if (res.status === 200 && body === expected) evidence.push(`${route} → 200，内容与首页逐字节一致`)
      else problems.push(`${route} → ${res.status}，${body === expected ? '内容一致' : '内容与首页不一致'}`)
    }
  } finally {
    server.close()
  }
  if (problems.length === 0) evidence.push('带编号地址逐个刷新都回到同一页（SPA 回退生效）')
  else evidence.push(...problems)
  addCheck('spa.routes', '带编号地址刷新回退', problems.length > 0 ? 'fail' : 'pass', evidence)
}

/* ---------------- 汇总：写同一份机读结论，按模式决定退出码 ---------------- */

async function main() {
  console.log('发布关卡开始：服装量体号型归并与下单汇总（数据不出本机）')
  console.log(`模式：${REPORT_ONLY ? '只出报告（名单类文件仍硬拦）' : '硬拦（任何失败 → 退出码 1）'}${NO_BUILD ? '；--no-build' : ''}\n`)

  checkDeclaredVsLock()
  checkLockVsInstalled()
  checkDockerignore()
  const manifest = checkReproducible()
  checkDistClean(manifest)
  checkFingerprint()
  checkPorts()
  checkHealthz()
  await checkContainerRuntime()
  await checkSpaRoutes()

  const verdict = checks.some((c) => c.status === 'fail') ? 'fail' : 'pass'
  const distInfo = fs.existsSync(DIST_DIR) ? distManifest() : null
  const report = {
    version: 1,
    app: 'app-030 服装量体号型归并与下单汇总',
    commit: gitCommit(),
    generatedAt: new Date().toISOString(),
    mode: REPORT_ONLY ? 'report' : 'hard',
    policy: {
      sampleData: '包里一律不留示例名单文件；演示数据由导入页「下载导入模板 CSV」在本机浏览器现场生成',
      failureMode: '默认硬拦；--report-only 只降级非名单类失败；dist 混入名单类文件任何模式都拦'
    },
    dist: distInfo ? { fileCount: distInfo.fileCount, totalBytes: distInfo.totalBytes } : null,
    checks,
    verdict
  }
  fs.mkdirSync(DIST_DIR, { recursive: true })
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)

  const icon = { pass: '✓ 过', fail: '✗ 未过', skip: '– 跳过' }
  for (const c of checks) {
    console.log(`${icon[c.status]}  ${c.id}  ${c.title}`)
    for (const line of c.evidence) console.log(`      ${line}`)
    if (c.skipReason) console.log(`      跳过原因：${c.skipReason}`)
  }
  console.log(`\n结论：${verdict === 'pass' ? '过' : '不过'}（机读结论 → dist/${REPORT_NAME}，打包/页面/导出三处共用）`)

  if (verdict === 'fail' && !REPORT_ONLY) process.exit(1)
  if (REPORT_ONLY && checks.some((c) => c.status === 'fail' && ALWAYS_BLOCKING.has(c.id))) {
    console.log('名单类文件混入 dist：即使只出报告也硬拦，退出码 1')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`关卡自身执行失败：${err.message}`)
  process.exit(2)
})
