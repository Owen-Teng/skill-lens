---
name: "{{skill_name}}"
description: "{{when_to_use_and_result}}"
---

# {{display_name}}

## 使用场景

- 触发条件：{{trigger}}
- 适用范围：{{scope}}
- 不适用范围：{{out_of_scope}}

## 输入要求

| 输入 | 用途 | 是否必需 | 缺失时怎样处理 |
|---|---|---|---|
| {{input_name}} | {{purpose}} | {{required_or_optional}} | {{missing_input_action}} |

## 执行步骤

### S01 {{step_title}}

- 执行方：{{AI_人工_工具_待确认}}
- 输入：{{step_input}}
- 操作：{{specific_action}}
- 输出：{{step_output}}
- 完成判据：{{observable_check}}
- 异常/停止：{{failure_or_wait_condition}}
- 下一步：{{existing_step_id_or_STOP_or_WAIT_with_resume_step_id}}

按同一格式继续 S02、S03。每个步骤使用唯一编号，条件分支写明条件及目标编号；循环写明返回点与停止条件。没有工具或授权时，不把系统操作写成已能自动执行。

每个“下一步”至少写一个已定义步骤编号，或终止标记 STOP。需要等待时写 WAIT，并同时写明由谁补齐什么、恢复条件及恢复到的已定义步骤，不能只写 WAIT 或“完成”。例如：“材料缺失时 WAIT；由用户补齐课程名称和反馈正文后返回 S01；齐全时进入 S02”。人工确认可写：“WAIT；由培训负责人确认分歧表达后进入 S03”。示例编号须替换为本候选实际存在的步骤，等待与恢复条件的含义仍由 Agent 和用户核对。

## 人工确认与停止条件

| 条件 | 由谁确认或补充 | 暂停/停止的位置 | 满足后进入哪里 |
|---|---|---|---|
| {{gate_condition}} | {{responsible_role_or_unknown}} | {{step_id}} | {{next_step_id_or_STOP}} |

没有额外确认点时明确写“无额外确认点，以输入与执行步骤中的停止条件为准”，不为填模板发明审批。

## 输出格式

- 交付类型：{{output_type}}
- 必须包含：{{required_output_fields}}
- 固定结构或示例：{{concrete_output_schema_or_example}}
- 状态表述：{{draft_done_or_unverified_rules}}

## 完成检查

- {{task_specific_acceptance_check}}
- 只把有实际检查依据的结果标为完成；未执行、待确认与已完成分开。

## 工具与资料

- 可用工具：{{available_tools_or_none}}
- 需要但未提供的能力：{{missing_dependencies_or_none}}
- 按需资料与出处：{{relative_references_and_locators}}

## 限制与待确认

- {{unresolved_scope_rule_or_dependency_or_none}}

填写规则：生成候选时替换所有双花括号占位符，删去写给编写者的模板说明。原材料没有的信息明确写“待确认”及其对执行的影响；不造负责人、工具、权限、数字或效果。具体业务步骤与已有授权优先，模板本身不授予额外权限。
