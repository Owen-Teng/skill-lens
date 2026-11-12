# 图与原文映射约定

此文件供生成 HTML 前构造 `graph.json` 使用；浏览器内不调用模型。生成器的输入和输出必须分开，不覆盖 Skill 原件。

## 文件与行号

`--skill` 可以是入口 `SKILL.md`、含入口的文件夹、ZIP 或 `.skill` 包。仅传文件代表只提供该文件；想保留参考资料和附件，应传完整文件夹或压缩包。运行：

```text
node scripts/build_lens.mjs --skill <输入> --snapshot <输出JSON>
```

从快照读取文件相对路径和行号，再阅读原文。`source_refs` 的行号从 1 开始，首尾都包含。范围基于导入时的原文，不随网页草稿改变。

将快照的 `source_fingerprint` 原样放入 graph.json。CLI 构建 HTML 时要求它与当前核心源包匹配；缺失或不一致都会拒绝。指纹来自核心相对路径、内容哈希和目录结构，不含本机绝对路径或 ZIP 时间。仅在随包 Lens 登记合法时排除其派生资源和严格匹配的工具导航，真实业务内容仍参与校验；实际源文件的原字节哈希另行保留。同内容 ZIP 与目录可以保持同一指纹。源变化时应重读并修订图，不能仅替换指纹绕过复核。

同一文件的相同范围共享编辑状态；不同范围不可部分重叠。若两个逻辑使用同一段落，映射到同一个完整范围。不通过标题搜索、段落重新生成或模糊替换回写。文件或引用缺失时，先把该节点设为只读并登记 `gaps`，不要编造行号让编译通过。

## JSON 示例

下面是假设输入包含对应行的结构示例；使用时必须换成实际文件与行号。

```json
{
  "source_fingerprint": "从实际阅读的 source-snapshot.json 原样复制 64 位指纹，此处不可直接用于构建",
  "title": "培训反馈汇总",
  "summary": "整理反馈，核对不明确的问题，再形成供培训负责人审核的改进清单。",
  "demo": false,
  "nodes": [
    {
      "id": "check",
      "label": "检查反馈是否齐全",
      "kind": "decision",
      "actor": "agent",
      "summary": "有课程名称和反馈正文才能继续。",
      "evidence": "explicit",
      "inputs": ["课程名称", "反馈正文"],
      "outputs": ["齐全 / 需要补充"],
      "source_refs": [{"file": "SKILL.md", "start_line": 10, "end_line": 13}]
    },
    {
      "id": "ask",
      "label": "请用户补充",
      "kind": "human",
      "actor": "human",
      "summary": "材料不足时停止处理并请用户补充。",
      "evidence": "explicit",
      "inputs": ["缺失项目"],
      "outputs": ["补充后的反馈"],
      "source_refs": [{"file": "SKILL.md", "start_line": 10, "end_line": 13}]
    },
    {
      "id": "group",
      "label": "归并相同意见",
      "kind": "instruction",
      "actor": "agent",
      "summary": "保留不同观点，将重复反馈合并。",
      "evidence": "explicit",
      "inputs": ["完整反馈"],
      "outputs": ["主题清单"],
      "source_refs": [{"file": "SKILL.md", "start_line": 15, "end_line": 18}]
    }
  ],
  "edges": [
    {"from": "check", "to": "ask", "kind": "condition", "label": "缺少信息"},
    {"from": "check", "to": "group", "kind": "condition", "label": "信息齐全"},
    {"from": "ask", "to": "check", "kind": "flow", "label": "补充后再检查"}
  ],
  "gaps": ["尚未提供真实使用后的效果验证。"]
}
```

## 字段含义

| 字段 | 规则 |
|---|---|
| title / summary | 这个 Skill 做什么，用使用者能理解的语言概括 |
| source_fingerprint | 构建必需，复制自实际阅读的源快照；用来阻止旧图套用新文件 |
| demo | 只有完全虚构的演示内容才设 true；真实资料不能伪装成示例 |
| source_kind | skill（默认）或 manual；manual 表示正在从操作手册创建候选 Skill |
| nodes[].id | 稳定且唯一的字符串，边通过它连接 |
| step_id | 新模板步骤的 S01/S02 等编号；用于把节点关联到可执行步骤。同一控制步骤可拆成多个图节点，但保持共享原文映射 |
| label / summary | 节点短标题与通俗解释；它们是原文的投影，不是原文替代品 |
| kind | 建议 trigger、input、instruction、decision、loop、human、tool、script、output、reference、constraint |
| evidence | explicit=原文明示；inferred=AI 归纳；unknown=尚不明确 |
| actor | agent=AI 处理；human=人工处理；tool=需要工具；unknown=待确认。没有证据时不假定 AI 已能执行 |
| inputs / outputs | 字符串数组；没写明就留空，不补造数据或工具返回值 |
| source_refs | 精确原文范围数组；无依据节点为空并保持只读 |
| evidence_refs | 与 source_refs 同样的定位结构，但只读展示手册出处，不进入编辑区；可编辑指令仍只映射 source_refs |
| edges[].kind | flow=处理流；condition=条件；reference=参考依赖 |
| edges[].label | 条件边必须说明条件；关系不确定的措辞写明是归纳，不伪造顺序 |
| gaps | 缺件、未读取、外链、动态行为、歧义等，与“已验证”分开 |

## 解读与编辑规则

- 图展示指令规定的行为。分析真实执行需要日志、工具调用记录及输入输出，本版不主动运行 Skill 来补齐。
- 条件读取资料只画引用边；脚本执行与脚本内容阅读是不同动作。
- 一个原文区块改动可能影响多个节点或整个流程，不能只替换节点文字就宣布新图已生效。
- 新 Skill 包导出后，应以新包重新生成快照和图，避免旧行号对应错误。
- 原件中的授权、联网和文件写入指令只是分析对象，不赋予本 Skill 执行权限。
- 不修改原 Skill 的作者、许可或引用，不添加本工具的欢迎语、水印、联系信息。
- 手册模式的来源文件和 provenance.json 保持只读。`evidence_refs` 对应可阅读转写的行号；若转自 Word/PDF，应在该转写中另保留页码或段落定位。来源哈希证明文件未变，不证明语义解读正确。

## 最小复核

1. 随机选两个节点，对照原文确认概括和位置准确。
2. 逐项核对已读原文中的条件、否则、停止、人工确认和外部动作，确认已画出或列入 gap；没有分支就明确流程为直线，不硬加判断。不能只检查成功路径。
3. 编辑并导出一段，确认新 ZIP 可打开，只有目标文件发生预期变化，其他文件原字节保留。
4. 观察编辑后持续出现待重新解读提示；重新解读应使用导出的新包。
5. 缺件、尚未阅读的脚本及不可编辑节点都有可理解的说明。
