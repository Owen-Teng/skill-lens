# Validation · 验证范围

**v0.7.1 · Independent public interface edition** · 2026-11-12

The demo was regenerated with the public compiler from four synthetic source files and their original graph. Its ZIP and HTML have new hashes.

| Scope | Observed result |
|---|---|
| Public build, Node.js 24.15.0 | 59 tests: 58 passed, 0 failed, 1 Windows symlink case skipped for lack of privilege. Directory junction rejection passed. |
| Offline Chromium, public example | 14 nodes rendered. Hover highlighted neighbors; opening a node exposed its source editor. Edited text appeared in the exported Skill ZIP. Opt-in included both current and original HTML. Neither carried the previous corporate mark. Desktop 1440×900; mobile width 390 checked for page overflow. |
| Earlier candidate, Node.js 24.11.1 | The previous validation recorded 79 compatibility checks, 1,557 Unicode path comparisons, 24 DOM checks and six simulated platform generations. These historical checks were not all rerun on v0.7.1. |

From the repository root:

~~~sh
node --test skill-lens/scripts/build_lens.test.mjs skill-lens/scripts/platform_tool.test.mjs skill-lens/scripts/prepare_manual.test.mjs
~~~

本版单独复测了 Node 用例和离线浏览器编辑导出。前版兼容性与模拟接入数字只作历史依据，不算作新版重跑结果。合成材料不能证明任意手册或模型都能准确转换，也不代表已接入真实企业平台。来源目录稳定、任务隔离、用户权限与成果交付由平台负责。
