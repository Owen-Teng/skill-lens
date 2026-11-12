# 平台接入与 Agent 调用

员工操作保持为“上传 Skill / 操作手册 → 查看图 → 局部修改 → 下载自己的 Skill”。运行环境由公司 Agent 平台统一提供；员工无需下载安装 Python、Node.js 或命令行工具。此包是可接入候选，尚未连接或部署到具体公司平台。

## 平台管理员一次配置

1. 将完整 `skill-lens/` 放入平台工具/技能目录。执行环境提供 Node.js 24.x，测试目标是 **24.11.1**；所有执行模块均为 `node:` 内置模块，无 npm 安装步骤。
2. 每次任务分配独立目录，例如 `/jobs/<opaque-job-id>/`，将该用户获准的附件放入 `input/`。上传ZIP交给生成器校验，不由平台用不受控路径自动解压。任务目录的存储、租户权限、并发隔离和回收由平台管理。
3. 注册一个工具 `skill_lens`，参数约定见 [工具参数](platform-tool-schema.json)。命令为 `node <技能目录>/scripts/platform_tool.mjs --workspace <本任务绝对目录>`；把工具参数 JSON 写入 stdin，读取 stdout 的一条 JSON，非零退出表示失败。任务目录由平台配置，不由员工或模型选择。
4. 把返回的 `artifacts[].path` 解析为该任务目录内的成果文件，接入平台现有预览/下载机制，给出真实成果链接。CLI 返回的是相对路径，不是网址。HTML可直接作为下载文件；平台如内嵌预览，应沿用其现有文档预览隔离策略。

支持代码工具/命令工具的平台可直接使用该入口。仅支持HTTP工具的平台，可在现有工具服务中导入 `dispatchRequest(request,{workspace})`，复用平台身份、附件和成果存储；本包没有假定具体HTTP地址、认证方式或发布权限。浏览器本身不调用服务端文件系统。

## Agent 的标准调用

### 1. 快照与按需阅读

附件路径由平台给出。例如原包暂存为 `input/example.zip`：

```json
{"action":"snapshot","skill":"input/example.zip","snapshot":"work/source-snapshot.json"}
```

返回来源指纹、文件列表、可读性与行数，不把二进制 Base64 和全部正文塞进对话。用返回指纹阅读实际相关文件：

```json
{"action":"read_source","skill":"input/example.zip","source_fingerprint":"<快照返回的64位指纹>","file":"SKILL.md","start_line":1,"end_line":20}
```

行范围必须真实存在，单次最多500行、正文256 KiB；按实际行数请求，较长文本分次读取。空文件可从清单识别，没有可读行。二进制只返回元数据，不宣称理解其内容。来源变化会拒绝旧指纹，需重做快照和语义复核。

### 2. 手册生成候选（已有 Skill 跳过）

Agent按固定模板起草 `draft_text`；工具负责校验、保全原手册和建立来源登记：

```json
{"action":"prepare_manual","manual":"input/manual.md","draft_text":"<完整候选SKILL.md>","output":"work/my-skill"}
```

若由Word/PDF转写，`manual` 指向可阅读的UTF-8 MD/TXT，并另传 `original` 为原件路径。也可用 `draft` 指向平台已写好的草稿文件；`draft` 与 `draft_text` 二选一。对返回的 `skill` 候选目录重新调用 snapshot、read_source，并制作 graph。

### 3. 构建 HTML

完成语义核对后，把真实 `source_fingerprint`、节点、边、缺口与准确行范围放入 graph 对象：

```json
{"action":"build","skill":"work/my-skill","graph":{"source_fingerprint":"<当前快照指纹>","title":"按实际材料填写","nodes":[],"edges":[],"gaps":[]},"output":"output/skill-map.html"}
```

此处是参数形状示例，空nodes会被拒绝；实际graph遵循 [映射约定](graph-schema.md)。`graph` 也可为平台已写好的 JSON 文件相对路径。工具验证图与来源、映射和证据后生成成果；平台提供下载链接，员工在浏览器里继续修改和保存。任一校验错误保留原件、报告具体问题，不把工具生成成功当作业务已执行。

## 适配边界

- 请求最多4 MiB，较大图/草稿可作为任务文件传路径。仅接受任务目录内相对路径，拒绝绝对路径、越界、符号链接/目录联接和覆盖已有成果。
- Agent负责理解；编译器不会调用模型、OCR、运行源包脚本或访问外链。平台若没有Word/PDF提取工具，明确记录缺口。
- Node文件检查和相对路径约束属于应用层检查；真实多用户部署使用平台隔离的任务容器/目录，不能把任意可写共享目录当作完整沙箱。已有任务目录和来源在任务执行期间由平台保持稳定。
- 平台将上传内容暂存为常规文件。符号链接与Windows目录联接会被拒绝；标准Node的Stats不能完整识别所有非链接型Windows重解析标签（例如部分云占位文件），这类来源先由平台附件服务物化为常规文件。生产接入的目录稳定性与隔离由平台承担。
- 平台暂未接入时，交付可做的解读或候选并说明HTML尚未构建；请管理员配置工具，不要求员工补装软件。
