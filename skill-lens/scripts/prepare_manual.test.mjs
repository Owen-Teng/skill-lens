import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { LensError, MAX_FILE_BYTES, prepareManual, validateDraft, validateGeneratedTemplate } from './prepare_manual.mjs';

const script = fileURLToPath(new URL('./prepare_manual.mjs', import.meta.url));
const temporaryRoot = fileURLToPath(new URL('../../evaluation/manual-dev/', import.meta.url));
fs.mkdirSync(temporaryRoot, { recursive: true });
const basicFrontmatter = 'name: sample-manual\ndescription: "用于核对本地手册并输出候选。"';
const step = (id = 'S01', next = 'STOP') => `### ${id} 核对材料\n\n- 执行方：AI\n- 输入：手册\n- 操作：读取原话并整理待确认点\n- 输出：候选\n- 完成判据：人工可回查\n- 异常/停止：资料缺失时暂停\n- 下一步：${next}\n`;
function candidate(frontmatter = basicFrontmatter, steps = step()) {
  return `---\n${frontmatter}\n---\n\n# 手册候选\n\n## 使用场景\n\n核对手册。\n\n## 输入要求\n\n本地转写。\n\n## 执行步骤\n\n${steps}\n## 人工确认与停止条件\n\n缺少资料时等待用户补齐。\n\n## 输出格式\n\nMarkdown 候选。\n\n## 完成检查\n\n出处可追溯。\n\n## 工具与资料\n\n仅本地原件。\n\n## 限制与待确认\n\n业务正确性待人工确认。\n`;
}
const bytes = value => Buffer.from(value, 'utf8');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'case-'));
  t.after(() => {
    const relative = path.relative(temporaryRoot, path.resolve(directory));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'cleanup remains inside manual-dev');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const manual = path.join(directory, '手册.txt');
  const draft = path.join(directory, '候选.md');
  const output = path.join(directory, 'candidate');
  fs.writeFileSync(manual, '手册原话\r\n逐字保留。');
  fs.writeFileSync(draft, candidate());
  return { directory, manual, draft, output };
}
function rejectsDraft(text, pattern) { assert.throws(() => validateDraft(bytes(text)), pattern); }
function rejectsTemplate(text, pattern) { assert.throws(() => validateGeneratedTemplate(bytes(text)), pattern); }

test('valid plain draft and complete generated template pass', () => {
  assert.equal(validateDraft(bytes(candidate())), undefined);
  assert.equal(validateGeneratedTemplate(bytes(candidate())), undefined);
});
test('UTF-8 BOM, CRLF and supported metadata remain valid', () => {
  const text = candidate(`${basicFrontmatter}\nmetadata:\n  author: 'Owen''s team'\n  nested:\n    purpose: "检索"\nlicense: MIT\ncompatibility: Local only\nallowed-tools: "Read"`).replaceAll('\n', '\r\n');
  const data = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(text)]);
  validateDraft(data);
  validateGeneratedTemplate(data);
});
test('literal and folded block strings, comments and quoted escapes pass', () => {
  validateDraft(bytes(candidate('name: sample-manual # note\ndescription: >-\n  用于核对\n  本地手册\n# comment\nmetadata:\n  text: |+\n    保留原话\n\n    第二段\n  escaped: "a\\nb\\\"c" # comment')));
});
test('empty, binary NUL and invalid UTF-8 drafts are rejected', () => {
  for (const data of [Buffer.alloc(0), Buffer.from(' \n'), Buffer.from([0xc0, 0x80]), Buffer.from([0xff]), bytes(`${candidate()}\0`)]) assert.throws(() => validateDraft(data), LensError);
});
test('validators require original Buffer bytes', () => {
  assert.throws(() => validateDraft(candidate()), /Buffer/);
  assert.throws(() => validateGeneratedTemplate(candidate()), /Buffer/);
});
test('both validators enforce 8 MiB input ceiling', () => {
  const oversized = Buffer.alloc(MAX_FILE_BYTES + 1, 65);
  assert.throws(() => validateDraft(oversized), /8 MiB/);
  assert.throws(() => validateGeneratedTemplate(oversized), /8 MiB/);
});
test('frontmatter must be at the beginning, closed, and followed by a body', () => {
  rejectsDraft(`\n${candidate()}`, /行首/);
  rejectsDraft('---\nname: x', /未闭合/);
  rejectsDraft(`---\n${basicFrontmatter}\n---\n`, /缺少正文/);
});
test('duplicate top-level and nested YAML keys fail instead of being discarded', () => {
  rejectsDraft(candidate(`${basicFrontmatter}\nname: other`), /重复键 name/);
  rejectsDraft(candidate(`${basicFrontmatter}\nmetadata:\n  author: one\n  author: two`), /重复键 author/);
});
test('unknown frontmatter and scalar metadata fail without silent deletion', () => {
  rejectsDraft(candidate(`${basicFrontmatter}\ncustom: preserve me`), /不支持字段 custom/);
  rejectsDraft(candidate(`${basicFrontmatter}\nmetadata: preserve me`), /metadata 须/);
});
test('YAML implicit booleans, nulls, dates and numeric forms fail', () => {
  for (const value of ['true', 'False', 'null', '~', 'yes', 'OFF', '.NaN', '+.inf', '1', '-12.5', '0xFF', '1e6', '2026-11-12', '2026-11-12T12:00:00']) {
    rejectsDraft(candidate(`name: sample-manual\ndescription: ${value}`), /非字符串/);
  }
});
test('quoted implicit YAML values remain strings', () => {
  for (const value of ['true', 'null', '2026-11-12', '0xFF']) validateDraft(bytes(candidate(`name: sample-manual\ndescription: "${value}"`)));
});
test('unsupported YAML collections, tags, aliases and complex values fail', () => {
  for (const value of ['[one, two]', '{x: one}', '&alias value', '*alias', '!tag text', '- item', '? key', 'one: two', 'value:']) {
    rejectsDraft(candidate(`${basicFrontmatter}\nmetadata:\n  value: ${value}`), /不支持的 YAML 值/);
  }
  rejectsDraft(candidate(`${basicFrontmatter}\nmetadata:\n  - item`), /键值映射/);
});
test('YAML tabs, odd indentation and valueless/empty blocks fail', () => {
  rejectsDraft(candidate(`${basicFrontmatter}\nmetadata:\n\tauthor: text`), /制表符/);
  rejectsDraft(candidate(`${basicFrontmatter}\nmetadata:\n   author: text`), /两空格/);
  rejectsDraft(candidate(`${basicFrontmatter}\nmetadata:`), /缺少值/);
  rejectsDraft(candidate('name: sample-manual\ndescription: |\n  '), /不能为空/);
});
test('malformed quotes and content after a quoted scalar fail', () => {
  for (const value of ['"unclosed', '"bad\\q"', '"ok" trailing', "'unclosed", "'ok'trailing"]) rejectsDraft(candidate(`name: sample-manual\ndescription: ${value}`), LensError);
});
test('name syntax and name/description lengths are checked by Unicode characters', () => {
  for (const value of ['Uppercase', '-leading', 'trailing-', 'double--dash', 'has space', 'a'.repeat(65), '']) rejectsDraft(candidate(`name: "${value}"\ndescription: text`), /name/);
  validateDraft(bytes(candidate(`name: ${'a'.repeat(64)}\ndescription: "${'😀'.repeat(1024)}"`)));
  rejectsDraft(candidate(`name: valid\ndescription: "${'😀'.repeat(1025)}"`), /description/);
  rejectsDraft(candidate('name: valid\ndescription: "   "'), /description/);
});
test('unfilled placeholders, missing modules, duplicate modules and wrong order fail', () => {
  rejectsTemplate(candidate().replace('核对手册。', '{{trigger}}'), /占位符/);
  rejectsTemplate(candidate().replace('## 完成检查', '## other'), /缺少固定模块/);
  rejectsTemplate(`${candidate()}\n## 使用场景\n重复`, /模块重复/);
  rejectsTemplate(candidate().replace('## 输入要求', '## 临时').replace('## 使用场景', '## 输入要求').replace('## 临时', '## 使用场景'), /顺序/);
});
test('empty and comment-only modules fail', () => {
  rejectsTemplate(candidate().replace('出处可追溯。', ''), /模块为空/);
  rejectsTemplate(candidate().replace('出处可追溯。', '<!-- 没有内容 -->'), /模块为空/);
});
test('all seven fields are required and fields may not repeat or be empty', () => {
  for (const field of ['执行方', '输入', '操作', '输出', '完成判据', '异常/停止', '下一步']) {
    const text = candidate().replace(new RegExp(`^- ${field.replace('/', '\\/')}：.*\\n`, 'm'), '');
    rejectsTemplate(text, /缺少字段/);
  }
  rejectsTemplate(candidate().replace('- 输入：手册', '- 输入：手册\n- 输入：另一份'), /重复字段/);
  rejectsTemplate(candidate().replace('- 输出：候选', '- 输出：'), /字段为空：输出/);
});
test('step IDs require S01, valid unique identifiers, and a title', () => {
  rejectsTemplate(candidate(basicFrontmatter, step('S02')), /S01/);
  rejectsTemplate(candidate(basicFrontmatter, step() + '\n' + step()), /编号重复/);
  rejectsTemplate(candidate(basicFrontmatter, step() + '\n' + step('S001')), /编号或标题无效/);
  rejectsTemplate(candidate().replace('### S01 核对材料', '### S01'), /编号或标题无效/);
});
test('next-step references must exist and terminal markers use token boundaries', () => {
  rejectsTemplate(candidate(basicFrontmatter, step('S01', 'S99')), /不存在的步骤/);
  for (const next of ['完成', 'STOPPED', 'XSTOP', 'S01suffix']) rejectsTemplate(candidate(basicFrontmatter, step('S01', next)), /下一步须写/);
  validateGeneratedTemplate(bytes(candidate(basicFrontmatter, step('S01', '进入 S02') + '\n' + step('S02', 'STOP'))));
});
test('WAIT requires a real recovery target, including when STOP is also present', () => {
  for (const next of ['WAIT', 'WAIT 或 STOP']) rejectsTemplate(candidate(basicFrontmatter, step('S01', next)), /缺少恢复/);
  rejectsTemplate(candidate(basicFrontmatter, step('S01', 'WAIT；用户补齐后 S99')), /不存在的步骤/);
  validateGeneratedTemplate(bytes(candidate(basicFrontmatter, step('S01', 'WAIT；用户补齐手册后返回 S01；齐全时 STOP'))));
});
test('headings and fields inside backtick and tilde fences do not count', () => {
  for (const marker of ['```', '~~~']) {
    rejectsTemplate(candidate().replace('## 完成检查\n\n出处可追溯。', `${marker}\n## 完成检查\n出处可追溯。\n${marker}`), /缺少固定模块/);
    rejectsTemplate(candidate().replace('- 执行方：AI', `${marker}\n- 执行方：AI\n${marker}`), /缺少字段/);
    rejectsTemplate(candidate(basicFrontmatter, `${marker}\n${step()}\n${marker}`), /S01/);
  }
});
test('a shorter or different fence cannot expose hidden steps', () => {
  rejectsTemplate(candidate(basicFrontmatter, `\n\`\`\`\`\n\`\`\`\n${step()}\n\`\`\`\`\n`), /S01/);
  rejectsTemplate(candidate(basicFrontmatter, `\n~~~\n\`\`\`\n${step()}\n~~~\n`), /S01/);
});
test('a next-step target occurring only in fenced code cannot satisfy routing', () => {
  rejectsTemplate(candidate(basicFrontmatter, step('S01', '\n```text\nSTOP\n```')), /下一步须写/);
});
test('packaging retains BOM/CRLF/manual/original/draft bytes and exact provenance schema', t => {
  const f = fixture(t);
  const manualBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes('手册\r\n原话。\r\n')]);
  const draftBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(candidate().replaceAll('\n', '\r\n'))]);
  const original = path.join(f.directory, '课件.PDF');
  const originalBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 0xff, 0x0d, 0x0a]);
  fs.writeFileSync(f.manual, manualBytes);
  fs.writeFileSync(f.draft, draftBytes);
  fs.writeFileSync(original, originalBytes);
  const result = prepareManual({ ...f, original });
  assert.deepEqual(result, { ok: true, source_kind: 'manual', output: f.output, files: 4, note: '仅打包候选指令与只读手册；未验证业务规则或实际执行能力' });
  assert.deepEqual(fs.readFileSync(path.join(f.output, 'SKILL.md')), draftBytes);
  assert.deepEqual(fs.readFileSync(path.join(f.output, 'references/manual-readable.md')), manualBytes);
  assert.deepEqual(fs.readFileSync(path.join(f.output, 'references/manual-original.pdf')), originalBytes);
  assert.deepEqual(fs.readFileSync(f.manual), manualBytes);
  assert.deepEqual(fs.readFileSync(f.draft), draftBytes);
  assert.deepEqual(fs.readFileSync(original), originalBytes);
  const expected = {
    schema_version: 1, source_kind: 'manual',
    readonly_files: ['references/manual-readable.md', 'references/manual-original.pdf', 'provenance.json'],
    sources: [
      { file: 'references/manual-readable.md', sha256: createHash('sha256').update(manualBytes).digest('hex'), role: 'readable', original_name: '手册.txt' },
      { file: 'references/manual-original.pdf', sha256: createHash('sha256').update(originalBytes).digest('hex'), role: 'original', original_name: '课件.PDF' },
    ],
  };
  assert.deepEqual(fs.readFileSync(path.join(f.output, 'provenance.json')), bytes(JSON.stringify(expected, null, 2)));
});
test('omitting original creates two provenance sources with the same immutable bytes', t => {
  const f = fixture(t);
  prepareManual(f);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.output, 'provenance.json')));
  assert.equal(manifest.sources.length, 2);
  assert.equal(manifest.sources[0].sha256, manifest.sources[1].sha256);
  assert.deepEqual(fs.readFileSync(path.join(f.output, 'references/manual-original.txt')), fs.readFileSync(f.manual));
});
test('unsafe original extensions fall back to .bin and nested new parents are supported', t => {
  const f = fixture(t);
  const original = path.join(f.directory, '无扩展名');
  fs.writeFileSync(original, 'original');
  f.output = path.join(f.directory, 'new-parent', 'nested', 'candidate');
  prepareManual({ ...f, original });
  assert.equal(fs.readFileSync(path.join(f.output, 'references/manual-original.bin'), 'utf8'), 'original');
});
test('manual extension, invalid UTF-8, empty and NUL text fail before output creation', t => {
  const f = fixture(t);
  const badExtension = path.join(f.directory, 'manual.pdf');
  fs.writeFileSync(badExtension, 'text');
  assert.throws(() => prepareManual({ ...f, manual: badExtension }), /仅支持 UTF-8/);
  for (const data of [Buffer.alloc(0), bytes('  \r\n'), bytes('a\0b'), Buffer.from([0xc3])]) {
    fs.writeFileSync(f.manual, data);
    assert.throws(() => prepareManual(f), LensError);
    assert.equal(fs.existsSync(f.output), false);
  }
});
test('oversized manual, draft and original fail before creating output', t => {
  const f = fixture(t);
  const huge = Buffer.alloc(MAX_FILE_BYTES + 1, 65);
  const original = path.join(f.directory, 'original.bin');
  fs.writeFileSync(original, huge);
  assert.throws(() => prepareManual({ ...f, original }), /8 MiB/);
  fs.writeFileSync(f.draft, huge);
  assert.throws(() => prepareManual(f), /8 MiB/);
  fs.writeFileSync(f.draft, candidate());
  fs.writeFileSync(f.manual, huge);
  assert.throws(() => prepareManual(f), /8 MiB/);
  assert.equal(fs.existsSync(f.output), false);
});
test('an exactly 8 MiB readable manual is accepted', t => {
  const f = fixture(t);
  fs.writeFileSync(f.manual, Buffer.alloc(MAX_FILE_BYTES, 65));
  prepareManual(f);
  assert.equal(fs.statSync(path.join(f.output, 'references/manual-readable.md')).size, MAX_FILE_BYTES);
});
test('existing directory or input file cannot become an output or be overwritten', t => {
  const f = fixture(t);
  fs.mkdirSync(f.output);
  const sentinel = path.join(f.output, 'sentinel');
  fs.writeFileSync(sentinel, 'keep');
  assert.throws(() => prepareManual(f), /输出目录已存在/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  const before = fs.readFileSync(f.manual);
  assert.throws(() => prepareManual({ ...f, output: f.manual }), /输出目录已存在/);
  assert.deepEqual(fs.readFileSync(f.manual), before);
});
test('input directories are rejected', t => {
  const f = fixture(t);
  const directory = path.join(f.directory, 'directory.txt');
  fs.mkdirSync(directory);
  assert.throws(() => prepareManual({ ...f, manual: directory }), /常规文件/);
  assert.throws(() => prepareManual({ ...f, draft: f.directory }), /常规文件/);
  assert.throws(() => prepareManual({ ...f, original: f.directory }), /常规文件/);
});
test('directory junction/symlink ancestors are rejected for manual, draft, original and output', t => {
  const f = fixture(t);
  const link = path.join(f.directory, 'junction');
  fs.symlinkSync(f.directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const options of [
    { ...f, manual: path.join(link, path.basename(f.manual)) },
    { ...f, draft: path.join(link, path.basename(f.draft)) },
    { ...f, original: path.join(link, path.basename(f.manual)) },
    { ...f, output: path.join(link, 'escaped-output') },
    { ...f, output: link },
  ]) assert.throws(() => prepareManual(options), /符号链接或目录联接/);
  assert.equal(fs.existsSync(path.join(f.directory, 'escaped-output')), false);
});
test('leaf file symlinks are rejected when the OS permits their creation', t => {
  const f = fixture(t);
  const link = path.join(f.directory, 'linked-manual.txt');
  try { fs.symlinkSync(f.manual, link, 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Windows account cannot create file symlinks; junction ancestor coverage still runs'); return; } throw error; }
  assert.throws(() => prepareManual({ ...f, manual: link }), /符号链接/);
  assert.throws(() => prepareManual({ ...f, output: link }), /符号链接/);
});
test('supplied manual commands are copied as data and never executed', t => {
  const f = fixture(t);
  const marker = path.join(f.directory, 'must-not-exist');
  const input = `手册原话\nnode -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')"\n`;
  fs.writeFileSync(f.manual, input);
  prepareManual(f);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.readFileSync(path.join(f.output, 'references/manual-readable.md'), 'utf8'), input);
});
test('CLI accepts paths with spaces/Unicode and --option=value, returns JSON', t => {
  const f = fixture(t);
  f.output = path.join(f.directory, 'with spaces 输出');
  const result = spawnSync(process.execPath, [script, `--manual=${f.manual}`, '--draft', f.draft, '--output', f.output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).ok, true);
});
test('CLI reports invalid flags/missing arguments as JSON failure and supports help', () => {
  for (const args of [[], ['--manual'], ['--unknown', 'x']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).ok, false);
    assert.equal(result.stdout, '');
  }
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--manual/);
});
