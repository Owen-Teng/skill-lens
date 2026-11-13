# Validation · 验证范围

**v0.8.2 · Independent public edition · 2026-11-13**

| Check | Result |
|---|---|
| Public source, Node.js 24.15.0 on Windows | 61 tests, 60 passed, 0 failed. One file symlink test skipped because the account lacks that privilege. Directory junction coverage ran. |
| Public reader, offline Chromium | Opened the inventory decision, read lines 4–5 of the manual, edited the candidate and exported a ZIP. All four files survived, with only SKILL.md changed. Both walkthroughs show the actual public build. |
| Compiler output | The public example uses the same graph, source files and mappings as the v0.8.2 development example. It has two areas, 14 nodes and 22 relationships. |
| Route comparison on the development example | Unrelated centerline crossings fell from 43 to 3, unrelated overlap from 2,229 px to 0 px, and unrelated routes crossing condition labels from 19 to 0. These are geometric measurements on this example. |

Run the public tests from the repository root with Node.js 24:

~~~sh
node --test skill-lens/scripts/build_lens.test.mjs skill-lens/scripts/platform_tool.test.mjs skill-lens/scripts/prepare_manual.test.mjs
~~~

公开版单独验证了工具测试、示例打开、查看原文、修改和导出。上表的走线对比来自开发版同一份合成示例。流程图描述材料里的步骤，实际业务能否执行、AI 是否理解准确仍需人工核对。平台接入说明供部署方使用，尚未连接真实公司平台。
