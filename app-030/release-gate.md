# 发布关卡说明（release-gate）

交包之前的最后一道人工关卡改成机器关卡：`npm run gate` 跑完给结论，结论只有一份机读文件
`dist/release-gate-report.json`。**打包脚本（退出码）、首页「交付自检」、导出页「导出说明」三处读同一份文件，
不各写一套判断**；任何一处显示的结论与其他两处不一致，以该文件为准排查，不得单独改某一处。

## 两个取舍（已定）

### 取舍一：包里一律不留示例名单文件

- **决定：剥干净。** 包（dist 与镜像）里不允许出现任何表格 / 逗号分隔文本等名单类文件
  （`*.csv / *.xlsx / *.xls / *.tsv / *.numbers`，以及 `data/ samples/ exports/ measurements/` 目录）。
  演示要数据，用导入页「下载导入模板 CSV」在本机浏览器现场生成示例行（`示例·张三` 等虚构数据），
  文件不随包分发。
- 两条路的代价：留一份示例 → 演示开箱即用，但示例文件与真实名单同格式同目录，打包时极易把真名单一起带走，
  且示例也可能被误当可外传材料；剥干净 → 演示前多一步「下载模板 → 导入」，但包里永远不可能夹带名单。
- **必须选剥干净的情况**：包要离开这台机器——交付学校/厂方、推送镜像仓库、发给任何第三方。
  本应用承诺「量体数据不出本机」，而包里一旦带名单就无从收回，所以本项目**任何交付场景都按剥干净执行**，
  没有例外开关。

### 取舍二：自检不过默认硬拦

- **决定：默认硬拦。** `npm run gate` 任何检查项不过 → 退出码 1；Dockerfile 里
  `npm run build && node scripts/release-gate.mjs --no-build`，镜像构建随之失败。
- `--report-only`（或 `GATE_MODE=report`）只在本机临时调试打包时用：非名单类失败只出报告不拦。
  **但 `dist.clean`（名单类文件混入）在任何模式下都硬拦**——带名单出门没有「临时放行」。
- 两条路的代价：硬拦 → 能挡住带名单出门，但依赖没装、工具缺失等环境问题时临时打包也走不通；
  只出报告 → 灵活，但结论靠人看，忙起来等于没拦。
- **必须硬拦的情况**：产物要离开这台机器（交付、发版、镜像入库）。此时「靠人看报告」不构成关卡。

## 检查项（按执行顺序）

| # | 检查项 id | 内容 | 不过时的处理 |
|---|-----------|------|--------------|
| 1 | `deps.declared-vs-lock` | package.json 声明了、package-lock.json 里没有的，当场点名 | 补 `npm install` 重新生成锁定 |
| 2 | `deps.lock-vs-installed` | 锁定版本与 node_modules 实装版本逐一比对（声明/锁定/实装同一套） | `npm ci` 重装；无 node_modules 则跳过并写明 |
| 3 | `context.dockerignore` | 构建上下文必须排除 `node_modules / dist / .git / .env / *.log / coverage / data/ / samples/ / exports/ / **/*.csv / **/*.xlsx`；模拟生效后的上下文 < 5MB 且无名单类文件 | 补 `.dockerignore` 规则或移走文件 |
| 4 | `build.reproducible` | 同一提交连续打包两次，文件清单、逐文件体积与内容哈希必须一致 | 排查构建中的时间戳/随机量 |
| 5 | `dist.clean` | 报出包多大、多少文件；查名单类文件、`src/`、`node_modules/`、上次构建残留（本次构建未重写的文件） | **任何模式都硬拦** |
| 6 | `assets.fingerprint` | 首页引到的带版本号文件名里要有内容指纹；带指纹资源 `immutable, max-age=31536000`，首页 `no-cache, no-store` | 查 vite/nginx 配置 |
| 7 | `container.ports` | compose 对外发布的容器端口 = Dockerfile EXPOSE = nginx listen | 三处对齐 |
| 8 | `container.healthz` | `/healthz` 应答 200 且内容为 `ok`，Dockerfile 与 compose 的健康检查请求同一路径 | 对齐 nginx.conf 与健康检查 |
| 9 | `container.runtime` | 容器实测：端口可连、`/healthz` 内容正确 | 本机无 docker 或容器未运行 → 跳过并写明原因 |
| 10 | `spa.routes` | `/measure/:id` 等带编号地址逐个打开刷新，都回到同一页（与首页逐字节一致） | 查 nginx `try_files` 回退 |

跳过规则：机器上没相应工具（docker、node_modules 未装等）→ 该项 `status=skip` 并写明原因，
不算过也不算不过；交包前能用工具的环境必须补跑到「过」。

## 机读结论格式

```jsonc
{
  "version": 1,
  "commit": "…",
  "generatedAt": "…",
  "mode": "hard | report",
  "policy": { "sampleData": "…", "failureMode": "…" },
  "dist": { "fileCount": 0, "totalBytes": 0 },
  "checks": [{ "id": "…", "title": "…", "status": "pass|fail|skip", "evidence": ["…"], "skipReason": "…" }],
  "verdict": "pass | fail"
}
```

每个检查项都带：过没过（status）、证据（evidence）、跳过原因（skipReason，仅跳过时）。
