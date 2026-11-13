import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { dispatchRequest } from './platform_tool.mjs';

const cwd = path.resolve(process.cwd());
function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(cwd, 'skill-lens-platform-'));
  t.after(() => { const checked = path.resolve(workspace); assert.ok(checked.startsWith(cwd + path.sep) && path.basename(checked).startsWith('skill-lens-platform-')); fs.rmSync(checked, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(workspace, 'input/source'), { recursive: true });
  const text = '---\r\nname: example\r\ndescription: 汇总文字\r\n---\r\n# 工作流 😀\r\n整理文字，不发送。\r\n';
  fs.writeFileSync(path.join(workspace, 'input/source/SKILL.md'), text);
  const binary = Buffer.from([0, 255, 128, 1]);
  fs.writeFileSync(path.join(workspace, 'input/source/data.bin'), binary);
  return { workspace, text, binary, run: request => dispatchRequest(request, { workspace }) };
}
const graphFor = fingerprint => ({ source_fingerprint: fingerprint, title: '例子', nodes: [{ id: 'a', label: '整理', actor: 'agent', evidence: 'explicit', source_refs: [{ file: 'SKILL.md', start_line: 6, end_line: 6 }] }], edges: [] });
const draft = `---
name: manual-example
description: 依据材料起草待确认记录
---
# 记录
## 使用场景
按用户材料整理。
## 输入要求
正文必需，缺失暂停。
## 执行步骤
### S01 核对整理
- 执行方：AI
- 输入：材料
- 操作：整理正文。
- 输出：草稿
- 完成判据：有来源
- 异常/停止：缺输入等待用户补齐
- 下一步：缺材料WAIT，用户补齐后返回S01；完成后STOP。
## 人工确认与停止条件
用户补齐材料后返回S01。
## 输出格式
带来源的草稿。
## 完成检查
未知项不造数据。
## 工具与资料
仅所给手册。
## 限制与待确认
未执行真实业务。
`;

test('snapshot returns a progressive manifest, exact fingerprint and relative artifact', t => {
  const f = fixture(t), r = f.run({ action: 'snapshot', skill: 'input/source', snapshot: 'work/snapshot.json' });
  assert.equal(r.ok, true); assert.match(r.source_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(r.files.length, 2); assert.ok(r.files.every(file => !Object.hasOwn(file, 'numbered_lines') && !Object.hasOwn(file, 'base64')));
  assert.equal(r.artifacts[0].path, 'work/snapshot.json'); assert.ok(!JSON.stringify(r).includes(f.workspace));
});
test('read_source binds to snapshot and returns actual numbered lines without executing text', t => {
  const f = fixture(t), s = f.run({ action: 'snapshot', skill: 'input/source', snapshot: 'work/s.json' });
  const r = f.run({ action: 'read_source', skill: 'input/source', source_fingerprint: s.source_fingerprint, file: 'SKILL.md', start_line: 5, end_line: 6 });
  assert.deepEqual(r.numbered_lines, [{ line: 5, text: '# 工作流 😀' }, { line: 6, text: '整理文字，不发送。' }]);
});
test('binary read returns metadata only, original byte contents preserved', t => {
  const f = fixture(t), s = f.run({ action: 'snapshot', skill: 'input/source', snapshot: 'work/s.json' });
  const r = f.run({ action: 'read_source', skill: 'input/source', source_fingerprint: s.source_fingerprint, file: 'data.bin' });
  assert.equal(r.file.readable, false); assert.ok(!JSON.stringify(r).includes('base64'));
  assert.deepEqual(fs.readFileSync(path.join(f.workspace, 'input/source/data.bin')), f.binary);
});
test('changed source rejects old read fingerprint', t => {
  const f = fixture(t), s = f.run({ action: 'snapshot', skill: 'input/source', snapshot: 'work/s.json' });
  fs.appendFileSync(path.join(f.workspace, 'input/source/SKILL.md'), '新行。\n');
  assert.throws(() => f.run({ action: 'read_source', skill: 'input/source', source_fingerprint: s.source_fingerprint, file: 'SKILL.md' }), /变化/);
});
test('build accepts inline graph and preserves source/binary', t => {
  const f = fixture(t), s = f.run({ action: 'snapshot', skill: 'input/source', snapshot: 'work/s.json' });
  const r = f.run({ action: 'build', skill: 'input/source', graph: graphFor(s.source_fingerprint), output: 'output/map.html' });
  assert.equal(r.ok, true); assert.equal(r.artifacts[0].path, 'output/map.html');
  const html = fs.readFileSync(path.join(f.workspace, 'output/map.html'), 'utf8');
  assert.ok(html.includes('relation-root')); assert.ok(html.includes('0.8.2'));
  assert.equal(fs.readFileSync(path.join(f.workspace, 'input/source/SKILL.md'), 'utf8'), f.text);
  assert.deepEqual(fs.readFileSync(path.join(f.workspace, 'input/source/data.bin')), f.binary);
});
test('build refuses stale inline graph and leaves requested output absent', t => {
  const f = fixture(t);
  assert.throws(() => f.run({ action: 'build', skill: 'input/source', graph: graphFor('0'.repeat(64)), output: 'output/no.html' }));
  assert.equal(fs.existsSync(path.join(f.workspace, 'output/no.html')), false);
});
test('prepare_manual accepts inline draft and preserves manual evidence', t => {
  const f = fixture(t), bytes = Buffer.from('# 手册\r\n先核对正文，不发送。\r\n');
  fs.writeFileSync(path.join(f.workspace, 'input/manual.md'), bytes);
  const r = f.run({ action: 'prepare_manual', manual: 'input/manual.md', draft_text: draft, output: 'work/my-skill' });
  assert.equal(r.files, 4); assert.equal(r.artifacts.length, 4);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'work/my-skill/SKILL.md'), 'utf8'), draft);
  assert.deepEqual(fs.readFileSync(path.join(f.workspace, 'work/my-skill/references/manual-readable.md')), bytes);
  assert.deepEqual(fs.readFileSync(path.join(f.workspace, 'input/manual.md')), bytes);
});
test('ambiguous/invalid candidate fields fail without creating candidate folder', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.workspace, 'input/manual.md'), '# 手册\n正文\n');
  for (const spec of [{ draft: 'input/a.md', draft_text: draft }, { draft_text: draft.replace('- 操作：整理正文。\n', '') }, { draft_text: null }]) {
    assert.throws(() => f.run({ action: 'prepare_manual', manual: 'input/manual.md', output: 'work/bad', ...spec }));
    assert.equal(fs.existsSync(path.join(f.workspace, 'work/bad')), false);
  }
});
test('strict relative paths, fields and actions reject unsupported access', t => {
  const f = fixture(t);
  for (const skill of ['../outside', '/absolute', 'C:/private', 'input\\source', './input/source']) assert.throws(() => f.run({ action: 'snapshot', skill, snapshot: 'work/a.json' }));
  for (const request of [{ action: 'exec', command: 'anything' }, { action: ['snapshot'], skill: 'input/source', snapshot: 'work/a.json' }, { action: 'snapshot', skill: 'input/source', snapshot: 'work/a.json', workspace: cwd }]) assert.throws(() => f.run(request));
});
test('bounded read range and nonexistent file are rejected', t => {
  const f = fixture(t), s = f.run({ action: 'snapshot', skill: 'input/source', snapshot: 'work/s.json' });
  for (const [start_line, end_line] of [[0,1],[1,501],[6,5],[1.5,2],[1,7]]) assert.throws(() => f.run({ action: 'read_source', skill: 'input/source', source_fingerprint: s.source_fingerprint, file: 'SKILL.md', start_line, end_line }));
  assert.throws(() => f.run({ action: 'read_source', skill: 'input/source', source_fingerprint: s.source_fingerprint, file: 'missing.md' }));
});
test('existing artifact is never silently overwritten', t => {
  const f = fixture(t), spec = { action: 'snapshot', skill: 'input/source', snapshot: 'work/s.json' };
  f.run(spec); const before = fs.readFileSync(path.join(f.workspace, 'work/s.json'));
  assert.throws(() => f.run(spec)); assert.deepEqual(fs.readFileSync(path.join(f.workspace, 'work/s.json')), before);
});
test('real stdin JSON CLI works with PATH empty and child-process permission denied', t => {
  const f = fixture(t), cli = fileURLToPath(new URL('./platform_tool.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--permission','--allow-fs-read=*','--allow-fs-write=*', cli, '--workspace', f.workspace], { input: JSON.stringify({ action: 'snapshot', skill: 'input/source', snapshot: 'work/stdin.json' }), encoding: 'utf8', env: { ...process.env, PATH: path.join(f.workspace, 'no-tools') } });
  assert.equal(result.status, 0, result.stderr); const r = JSON.parse(result.stdout); assert.equal(r.ok, true); assert.equal(r.artifacts[0].path, 'work/stdin.json');
});
test('malformed/oversized stdin fails with structured JSON and no source change', t => {
  const f = fixture(t), cli = fileURLToPath(new URL('./platform_tool.mjs', import.meta.url));
  for (const input of ['{broken', 'x'.repeat(4 * 1024 * 1024 + 1)]) {
    const result = spawnSync(process.execPath, [cli, '--workspace', f.workspace], { input, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).ok, false);
  }
  assert.equal(fs.readFileSync(path.join(f.workspace, 'input/source/SKILL.md'), 'utf8'), f.text);
});
