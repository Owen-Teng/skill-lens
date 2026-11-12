#!/usr/bin/env node
/** Package an Agent-written candidate with immutable manual evidence.
 * Zero third-party dependencies. No semantic conversion, OCR, model/network
 * calls, or execution of supplied content. APIs are synchronous.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export class LensError extends Error {
  constructor(message) { super(message); this.name = 'LensError'; }
}
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const REQUIRED_CANDIDATE_SECTIONS = Object.freeze(['使用场景', '输入要求', '执行步骤', '人工确认与停止条件', '输出格式', '完成检查', '工具与资料', '限制与待确认']);
export const REQUIRED_STEP_FIELDS = Object.freeze(['执行方', '输入', '操作', '输出', '完成判据', '异常/停止', '下一步']);
const TEMPLATE_PATH = fileURLToPath(new URL('../assets/generated-skill-template.md', import.meta.url));

function absolute(value, label = '路径') {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new LensError(`${label}须为非空文件路径`);
  return path.resolve(value);
}
function lstatOptional(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
// lstat detects Windows directory junctions as symbolic links. Inspect every
// existing component, including the leaf; never resolve a link to its target.
function checkAncestors(file) {
  const full = absolute(file);
  const root = path.parse(full).root;
  const pieces = path.relative(root, full).split(path.sep).filter(Boolean);
  let current = root;
  const rootInfo = lstatOptional(root);
  if (rootInfo?.isSymbolicLink()) throw new LensError(`不跟随符号链接或目录联接: ${root}`);
  for (let index = 0; index < pieces.length; index += 1) {
    current = path.join(current, pieces[index]);
    const info = lstatOptional(current);
    if (!info) return;
    if (info.isSymbolicLink()) throw new LensError(`不跟随符号链接或目录联接: ${current}`);
    if (index < pieces.length - 1 && !info.isDirectory()) throw new LensError(`祖先路径不是目录: ${current}`);
  }
}
function readInput(value) {
  const file = absolute(value);
  checkAncestors(file);
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new LensError(`仅支持常规文件: ${file}`);
  if (before.size > MAX_FILE_BYTES) throw new LensError(`单文件超过 8 MiB: ${path.basename(file)}`);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new LensError(`读取前文件发生变化: ${file}`);
    if (opened.size > MAX_FILE_BYTES) throw new LensError(`单文件超过 8 MiB: ${path.basename(file)}`);
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - total));
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > MAX_FILE_BYTES) throw new LensError(`单文件超过 8 MiB: ${path.basename(file)}`);
      chunks.push(chunk.subarray(0, count));
    }
    checkAncestors(file);
    const after = fs.lstatSync(file);
    if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino) throw new LensError(`读取期间文件发生变化: ${file}`);
    return Buffer.concat(chunks, total);
  } finally { fs.closeSync(descriptor); }
}
function decodeText(data, label) {
  if (!Buffer.isBuffer(data)) throw new LensError(`${label}须提供 Buffer 原字节`);
  if (data.length > MAX_FILE_BYTES) throw new LensError(`${label}超过 8 MiB`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { throw new LensError(`${label}须为 UTF-8 文本`); }
  if (text.includes('\0')) throw new LensError(`${label}含二进制空字符`);
  if (!text.trim()) throw new LensError(`${label}为空`);
  return text;
}
function splitLines(text) {
  if (!text) return [];
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
// YAML indentation is spaces only; other whitespace is not indentation.
function spaces(line) { return /^ */.exec(line)[0].length; }

function scalar(raw, key) {
  raw = raw.trim();
  if (raw.startsWith('"')) {
    let end = -1;
    let escaped = false;
    for (let index = 1; index < raw.length; index += 1) {
      if (!escaped && raw[index] === '"') { end = index; break; }
      if (!escaped && raw[index] === '\\') escaped = true;
      else escaped = false;
    }
    let value;
    try { value = JSON.parse(raw.slice(0, end + 1)); }
    catch { throw new LensError(`${key} 双引号值须使用 JSON 兼容的字符串转义`); }
    const trailing = raw.slice(end + 1).trim();
    if (trailing && !trailing.startsWith('#')) throw new LensError(`${key} 字符串结束后有不支持的内容`);
    if (typeof value !== 'string') throw new LensError(`${key} 须为字符串`);
    return value;
  }
  if (raw.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(raw);
    if (!match) throw new LensError(`${key} 单引号值未正确闭合`);
    return match[1].replaceAll("''", "'");
  }
  const comment = raw.indexOf(' #');
  const value = (comment < 0 ? raw : raw.slice(0, comment)).trimEnd();
  if (!value || '[]{}!,&*#?|>%@`'.includes(value[0]) || value.startsWith('- ') || value.startsWith(': ') || value.includes(': ') || value.endsWith(':')) {
    throw new LensError(`${key} 含不支持的 YAML 值；请保留内容并改成引号字符串或两空格映射`);
  }
  const typed = ['null', 'true', 'false', 'yes', 'no', 'on', 'off', '~', '.nan', '.inf', '-.inf', '+.inf'].includes(value.toLowerCase())
    || /^[-+]?(?:[0-9][0-9_,.:eExXaAbBcCdDfFoO+-]*|\.[0-9][0-9eE+-]*)$/.test(value)
    || /^\d{4}-\d{2}-\d{2}(?:$|[Tt ])/.test(value);
  if (typed) throw new LensError(`${key} 可能被 YAML 解释为非字符串；请给原值加引号`);
  return value;
}

function parseFrontmatterSubset(lines) {
  lines.forEach((line, index) => { if (line.includes('\t')) throw new LensError(`frontmatter 第 ${index + 2} 行含制表符；严格子集请用空格缩进或字符串转义`); });
  function mapping(start, level) {
    const result = Object.create(null);
    let position = start;
    while (position < lines.length) {
      const line = lines[position];
      if (!line.trim() || line.trimStart().startsWith('#')) { position += 1; continue; }
      const depth = spaces(line);
      if (depth < level) break;
      if (depth !== level) throw new LensError(`frontmatter 第 ${position + 2} 行缩进不支持；映射须每层两空格`);
      const match = /^([\p{L}\p{N}_-]+)\s*:\s*(.*)$/u.exec(line.slice(level));
      if (!match || !/^[\p{L}_]/u.test(match[1])) throw new LensError(`frontmatter 第 ${position + 2} 行不是支持的键值映射`);
      const [, key, matchedRaw] = match;
      if (Object.hasOwn(result, key)) throw new LensError(`frontmatter 含重复键 ${key}`);
      position += 1;
      const raw = matchedRaw.trim();
      if (['|', '>', '|-', '>-', '|+', '>+'].includes(raw)) {
        const block = [];
        while (position < lines.length && (!lines[position].trim() || spaces(lines[position]) > level)) {
          const current = lines[position];
          if (current.trim() && spaces(current) < level + 2) throw new LensError(`${key} 块字符串须至少缩进两空格`);
          block.push(current.trim() ? current.slice(level + 2) : '');
          position += 1;
        }
        if (!block.length || !block.join('\n').trim()) throw new LensError(`${key} 块字符串不能为空`);
        result[key] = block.join(raw.startsWith('|') ? '\n' : ' ');
      } else if (!raw || raw.startsWith('#')) {
        let nextLine = position;
        while (nextLine < lines.length && (!lines[nextLine].trim() || lines[nextLine].trimStart().startsWith('#'))) nextLine += 1;
        if (nextLine >= lines.length || spaces(lines[nextLine]) !== level + 2) throw new LensError(`${key} 缺少值；嵌套映射须缩进两空格`);
        [result[key], position] = mapping(position, level + 2);
      } else result[key] = scalar(raw, key);
    }
    return [result, position];
  }
  const [parsed, end] = mapping(0, 0);
  if (end !== lines.length) throw new LensError('frontmatter 有未解析内容；请改为受支持的字符串与两空格映射');
  return parsed;
}

export function validateDraft(data) {
  const text = decodeText(data, '候选 SKILL.md');
  const lines = splitLines(text);
  if (lines[0] !== '---') throw new LensError('候选 SKILL.md 缺少位于行首的 YAML frontmatter');
  const end = lines.findIndex((line, index) => index > 0 && line === '---');
  if (end < 0) throw new LensError('候选 SKILL.md 的 frontmatter 未闭合');
  const values = parseFrontmatterSubset(lines.slice(1, end));
  const supported = new Set(['name', 'description', 'metadata', 'license', 'compatibility', 'allowed-tools']);
  const unsupported = Object.keys(values).filter(key => !supported.has(key)).sort();
  if (unsupported.length) throw new LensError(`候选 frontmatter 含不支持字段 ${unsupported.join(', ')}；请确认目标 Agent 格式，不会静默删除这些字段`);
  for (const [key, value] of Object.entries(values)) {
    if (key === 'metadata') {
      if (!value || typeof value !== 'object') throw new LensError('metadata 须为两空格缩进的字符串映射');
    } else if (typeof value !== 'string' || !value.trim()) throw new LensError(`候选 frontmatter 的 ${key} 须为非空字符串`);
  }
  const name = values.name;
  if (typeof name !== 'string' || Array.from(name).length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new LensError('候选 name 须为 1—64 位小写字母、数字与连字符，不能含连续或首尾连字符');
  if (typeof values.description !== 'string' || !values.description.trim() || Array.from(values.description).length > 1024) throw new LensError('候选 description 须为 1—1024 个字符的字符串');
  if (!lines.slice(end + 1).join('\n').trim()) throw new LensError('候选 SKILL.md 缺少正文，不能把手册直接冒充 Skill');
}

function withoutCode(lines) {
  let fence = null;
  return lines.map(line => {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return '';
    }
    return fence ? '' : line;
  });
}
export function validateGeneratedTemplate(data) {
  const template = decodeText(readInput(TEMPLATE_PATH), '随包候选模板');
  if (REQUIRED_CANDIDATE_SECTIONS.some(title => !template.includes(`## ${title}`))) throw new LensError('随包候选模板缺少约定模块，请恢复完整 Skill Lens 包');
  const text = decodeText(data, '候选 SKILL.md');
  if (/\{\{[\s\S]*?\}\}/.test(text)) throw new LensError('候选中仍有未填写的 {{...}} 占位符；未知信息应写待确认及执行影响');
  const original = splitLines(text);
  const visible = withoutCode(original);
  const headings = [];
  visible.forEach((line, number) => { const match = /^##\s+(.+?)\s*$/.exec(line); if (match) headings.push([number, match[1].trim()]); });
  const sections = new Map();
  const order = [];
  headings.forEach(([number, title], index) => {
    if (!REQUIRED_CANDIDATE_SECTIONS.includes(title)) return;
    if (sections.has(title)) throw new LensError(`候选固定模块重复：${title}`);
    const end = headings[index + 1]?.[0] ?? visible.length;
    const body = original.slice(number + 1, end).join('\n');
    if (!body.replace(/<!--[\s\S]*?-->/g, '').trim()) throw new LensError(`候选固定模块为空：${title}`);
    sections.set(title, body);
    order.push(title);
  });
  const missing = REQUIRED_CANDIDATE_SECTIONS.filter(title => !sections.has(title));
  if (missing.length) throw new LensError(`候选缺少固定模块：${missing.join('、')}`);
  if (order.some((title, index) => title !== REQUIRED_CANDIDATE_SECTIONS[index])) throw new LensError('候选八个固定模块应按模板顺序排列');
  const stepLines = splitLines(sections.get('执行步骤'));
  const stepVisible = withoutCode(stepLines);
  const headers = [];
  stepVisible.forEach((line, number) => {
    const match = /^###\s+(S\d+)(?![\p{L}\p{N}_])(?:\s+(.+))?$/u.exec(line);
    if (match) headers.push([number, match[1], match[2]]);
  });
  if (!headers.length || !headers.some(item => item[1] === 'S01')) throw new LensError('执行步骤至少需要 ### S01 标题，不能仅有笼统说明');
  const identifiers = new Set();
  const nextTargets = [];
  const fieldPattern = /^\s*(?:[-*]\s*)?(执行方|输入|操作|输出|完成判据|异常\/停止|下一步)\s*[:：]\s*(.*?)\s*$/;
  headers.forEach(([number, identifier, title], index) => {
    if (!/^S(?:0[1-9]|[1-9]\d+)$/.test(identifier) || !title?.trim()) throw new LensError(`步骤编号或标题无效：${identifier}；请使用 S01、S02 等唯一编号`);
    if (identifiers.has(identifier)) throw new LensError(`候选步骤编号重复：${identifier}`);
    identifiers.add(identifier);
    const end = headers[index + 1]?.[0] ?? stepLines.length;
    const body = stepLines.slice(number + 1, end);
    const bodyVisible = stepVisible.slice(number + 1, end);
    const fields = [];
    bodyVisible.forEach((line, fieldNumber) => { const match = fieldPattern.exec(line); if (match) fields.push([fieldNumber, match[1], match[2]]); });
    const values = new Map();
    let nextVisible = '';
    fields.forEach(([fieldNumber, key, initial], fieldIndex) => {
      if (values.has(key)) throw new LensError(`步骤 ${identifier} 重复字段：${key}`);
      const fieldEnd = fields[fieldIndex + 1]?.[0] ?? body.length;
      const value = [initial, ...body.slice(fieldNumber + 1, fieldEnd)].join('\n').trim();
      if (!value) throw new LensError(`步骤 ${identifier} 字段为空：${key}`);
      values.set(key, value);
      if (key === '下一步') nextVisible = [initial, ...bodyVisible.slice(fieldNumber + 1, fieldEnd)].join('\n').trim();
    });
    const absent = REQUIRED_STEP_FIELDS.filter(key => !values.has(key));
    if (absent.length) throw new LensError(`步骤 ${identifier} 缺少字段：${absent.join('、')}`);
    const targets = [...nextVisible.matchAll(/(?<![A-Za-z0-9_])S\d+(?![A-Za-z0-9_])/g)].map(match => match[0]);
    const terminals = [...nextVisible.matchAll(/(?<![A-Za-z0-9_])(STOP|WAIT)(?![A-Za-z0-9_])/g)].map(match => match[0]);
    if (!targets.length && !terminals.length) throw new LensError(`步骤 ${identifier} 下一步须写现有 Sxx 步骤编号或 STOP/WAIT，不能仅写完成等状态`);
    if (terminals.includes('WAIT') && !targets.length) throw new LensError(`步骤 ${identifier} 下一步含 WAIT，但缺少恢复后的 Sxx 目标；请写明由谁补齐什么及满足后返回或进入哪一步`);
    nextTargets.push(...targets);
  });
  const dangling = [...new Set(nextTargets.filter(target => !identifiers.has(target)))].sort();
  if (dangling.length) throw new LensError(`下一步引用了不存在的步骤：${dangling.join('、')}`);
}

function makeOutputDirectory(output) {
  checkAncestors(output);
  if (lstatOptional(output)) throw new LensError('输出目录已存在；请使用不存在的新候选目录，不覆盖已有内容');
  const parent = path.dirname(output);
  const missing = [];
  for (let current = parent; !lstatOptional(current); current = path.dirname(current)) missing.push(current);
  for (const directory of missing.reverse()) {
    checkAncestors(directory);
    try { fs.mkdirSync(directory); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    checkAncestors(directory);
    if (!fs.lstatSync(directory).isDirectory()) throw new LensError(`输出祖先不是目录: ${directory}`);
  }
  checkAncestors(output);
  fs.mkdirSync(output); // Exclusive leaf creation: an existing directory is never reused.
  checkAncestors(output);
}
function writeExclusive(file, data) {
  checkAncestors(file);
  fs.writeFileSync(file, data, { flag: 'wx' });
}
export function prepareManual({ manual, draft, output, original } = {}) {
  const manualPath = absolute(manual, '--manual');
  const draftPath = absolute(draft, '--draft');
  const outputPath = absolute(output, '--output');
  if (!['.md', '.txt'].includes(path.extname(manualPath).toLowerCase())) throw new LensError('--manual 仅支持 UTF-8 .md/.txt；Word/PDF 须先由宿主 Agent 提取');
  const manualBytes = readInput(manualPath);
  decodeText(manualBytes, '手册转写');
  const draftBytes = readInput(draftPath);
  validateDraft(draftBytes);
  validateGeneratedTemplate(draftBytes);
  const originalPath = original == null ? manualPath : absolute(original, '--original');
  const originalBytes = readInput(originalPath);
  let extension = path.extname(originalPath).toLowerCase();
  if (!/^\.[a-z0-9]{1,12}$/.test(extension)) extension = '.bin';
  const originalRelative = `references/manual-original${extension}`;
  const sources = [
    { file: 'references/manual-readable.md', sha256: createHash('sha256').update(manualBytes).digest('hex'), role: 'readable', original_name: path.basename(manualPath) },
    { file: originalRelative, sha256: createHash('sha256').update(originalBytes).digest('hex'), role: 'original', original_name: path.basename(originalPath) },
  ];
  const manifest = { schema_version: 1, source_kind: 'manual', readonly_files: [...sources.map(item => item.file), 'provenance.json'], sources };
  makeOutputDirectory(outputPath);
  checkAncestors(path.join(outputPath, 'references'));
  fs.mkdirSync(path.join(outputPath, 'references'));
  for (const [relative, data] of [
    ['SKILL.md', draftBytes],
    [sources[0].file, manualBytes],
    [originalRelative, originalBytes],
    ['provenance.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')],
  ]) writeExclusive(path.join(outputPath, relative), data);
  return { ok: true, source_kind: 'manual', output: outputPath, files: 4, note: '仅打包候选指令与只读手册；未验证业务规则或实际执行能力' };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = Object.create(null);
    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index];
      if (argument === '--help' || argument === '-h') {
        process.stdout.write('Usage: node prepare_manual.mjs --manual FILE --draft FILE --output NEW_DIR [--original FILE]\n');
        return 0;
      }
      const equal = argument.indexOf('=');
      const option = equal < 0 ? argument : argument.slice(0, equal);
      if (!['--manual', '--draft', '--output', '--original'].includes(option)) throw new LensError(`不支持的参数: ${option}`);
      const value = equal < 0 ? argv[++index] : argument.slice(equal + 1);
      if (!value || value.startsWith('--')) throw new LensError(`${option} 缺少值`);
      options[option.slice(2)] = value;
    }
    for (const key of ['manual', 'draft', 'output']) if (!options[key]) throw new LensError(`缺少必需参数 --${key}`);
    process.stdout.write(`${JSON.stringify(prepareManual(options))}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    return 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
