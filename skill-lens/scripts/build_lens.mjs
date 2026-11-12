#!/usr/bin/env node
/** Static, local Skill Lens compiler. Reads sources; never executes them. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readZip, ZipError } from './zip.mjs';

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 512, MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const LENS_DIRECTORY = 'assets/skill-lens';
const LENS_MANIFEST_PATH = `${LENS_DIRECTORY}/manifest.json`;
const LENS_PATHS = { current: `${LENS_DIRECTORY}/index.html`, origin: `${LENS_DIRECTORY}/origin.html`, graph: `${LENS_DIRECTORY}/graph.json` };
const LENS_MANAGED_PATHS = new Set([...Object.values(LENS_PATHS), LENS_MANIFEST_PATH]);
const LENS_NAVIGATION_ID = 'skill-lens-view-links-v1';
const LENS_NAVIGATION_BLOCK = '\n\n<!-- skill-lens:view-links:v1 -->\n## Skill 图解\n\n- [查看当前 Skill 图解](assets/skill-lens/index.html)\n- [查看首次原图](assets/skill-lens/origin.html)\n\n<!-- /skill-lens:view-links:v1 -->\n';
const MAX_LENS_HTML_BYTES = 64 * 1024 * 1024, MAX_LENS_GRAPH_BYTES = 8 * 1024 * 1024;
const MAX_LENS_MANIFEST_BYTES = 64 * 1024, MAX_LENS_TOTAL_BYTES = 128 * 1024 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const SHA = /^[0-9a-f]{64}$/;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
export class LensError extends Error { constructor(message) { super(message); this.name = 'LensError'; } }
const fail = message => { throw new LensError(message); };
const decodeUtf8 = data => UTF8.decode(data);
const parseJson = (text, bom = false) => JSON.parse(bom ? text.replace(/^\uFEFF/, '') : text);
const own = (object, key) => Object.hasOwn(object, key);
function defaults(object, values) { for (const [key, value] of Object.entries(values)) if (!own(object, key)) object[key] = value; }
function sameKeys(object, keys) { return plainObject(object) && Object.keys(object).length === keys.length && keys.every(key => own(object, key)); }
function isSha(value) { return typeof value === 'string' && SHA.test(value); }
function codepointCompare(a, b) {
  const left = Array.from(a, c => c.codePointAt(0)), right = Array.from(b, c => c.codePointAt(0));
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
}
const sorted = values => [...values].sort(codepointCompare);
/** Unicode 14 default case folding, matching the original Python compiler.
 * Node 24's Unicode 16 adds 27 capital-letter folds; keep those codepoints
 * distinct so merely changing compiler runtimes cannot change path identity.
 */
function casefold(value) {
  return Array.from(value, character => {
    const code = character.codePointAt(0);
    if ([0x1c89, 0xa7cb, 0xa7cc, 0xa7da, 0xa7dc].includes(code) || (code >= 0x10d50 && code <= 0x10d65)) return character;
    if (code === 0x131) return character;
    if (code === 0x1e9e || code === 0xdf) return 'ss';
    if ((code >= 0x13a0 && code <= 0x13f5) || (code >= 0x13f8 && code <= 0x13fd) || (code >= 0xab70 && code <= 0xabbf)) return character.toUpperCase();
    return character.toUpperCase().toLowerCase();
  }).join('');
}
function parents(name) { const pieces = name.split('/'), result = []; while (pieces.length > 1) { pieces.pop(); result.push(pieces.join('/')); } return result; }
export function safeName(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || value.split('/').some(part => ['', '.', '..'].includes(part))) fail(`非法包路径: ${JSON.stringify(value)}`);
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail('包路径含无效 Unicode');
  for (const part of value.split('/')) {
    if (/[\x00-\x1f:<>|"?*]/u.test(part) || /[ .]$/u.test(part)) fail(`不支持的文件名: ${JSON.stringify(value)}`);
    const stem = part.split('.')[0].toUpperCase();
    if (['CON', 'PRN', 'AUX', 'NUL'].includes(stem) || /^(?:COM|LPT)[1-9]$/u.test(stem)) fail(`不支持的文件名: ${JSON.stringify(value)}`);
  }
  return value;
}
export function checkPlain(filename) {
  const info = fs.lstatSync(filename);
  if (info.isSymbolicLink() || (info.fileAttributes && (info.fileAttributes & 0x400))) fail(`不跟随符号链接或重解析点: ${filename}`);
  return info;
}
export function checkAncestors(filename) {
  let item = path.resolve(filename);
  for (;;) {
    try { checkPlain(item); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(item); if (parent === item) break; item = parent;
  }
}
function fileLimit(name) { return Object.values(LENS_PATHS).slice(0, 2).some(item => name === item || name.endsWith(`/${item}`)) ? MAX_LENS_HTML_BYTES : MAX_FILE_BYTES; }
function countBytes(haystack, needle) { let count = 0, at = 0; while ((at = haystack.indexOf(needle, at)) !== -1) { count++; at += needle.length; } return count; }
function deepEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((value, i) => deepEqual(value, right[i]));
  return plainObject(left) && plainObject(right) && Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => own(right, key) && deepEqual(left[key], right[key]));
}
function lensHtmlData(data, label) {
  let text; try { text = decodeUtf8(data); } catch { fail(`受管理 ${label} 必须是 UTF-8 HTML`); }
  const matches = [...text.matchAll(/<script\b[^>]*\s+id\s*=\s*["']lens-data["'][^>]*>(.*?)<\/script\s*>/gis)];
  if (matches.length !== 1) fail(`受管理 ${label} 缺少唯一的 lens-data`);
  let result; try { result = parseJson(matches[0][1]); } catch { fail(`受管理 ${label} 的 lens-data 无效`); }
  if (!plainObject(result) || !plainObject(result.package) || !Array.isArray(result.package.files)) fail(`受管理 ${label} 缺少核心来源快照`);
  if (own(result.package, 'portability')) fail(`受管理 ${label} 的核心快照不能携带历史阅读页载荷`);
  const seen = new Set();
  for (const file of result.package.files) {
    if (!plainObject(file) || typeof file.path !== 'string' || LENS_MANAGED_PATHS.has(file.path)) fail(`受管理 ${label} 不得把 Lens 派生文件嵌入核心快照`);
    const name = safeName(file.path), key = casefold(name);
    if (seen.has(key)) fail(`受管理 ${label} 核心路径重复或大小写冲突`); seen.add(key);
  }
  return result;
}
function extractLensBundle(payload, directories) {
  const lookup = new Map(payload), metadata = {};
  const state = { managed: false, origin_base64: null, origin_sha256: null, manifest: null };
  if (!lookup.has(LENS_MANIFEST_PATH)) return [payload, directories, state, metadata];
  const bytes = lookup.get(LENS_MANIFEST_PATH);
  if (bytes.length > MAX_LENS_MANIFEST_BYTES) fail('同名 Lens manifest 超过 64 KiB；保留原文件，不接管此路径');
  let manifest;
  try { manifest = parseJson(decodeUtf8(bytes), true); } catch { fail('同名 Lens manifest 无效或已改动；保留原文件，不覆盖自有内容'); }
  if (!sameKeys(manifest, ['schema_version', 'generated_by', 'navigation_id', 'retained_directories', 'current_source_fingerprint', 'files']) || manifest.schema_version !== 1 || manifest.generated_by !== 'skill-lens' || manifest.navigation_id !== LENS_NAVIGATION_ID) fail('assets/skill-lens/manifest.json 不是受支持的 Skill Lens 登记，存在路径冲突；不会接管或覆盖');
  const retained = manifest.retained_directories;
  if (!Array.isArray(retained) || retained.some(item => !['assets', LENS_DIRECTORY].includes(item)) || new Set(retained).size !== retained.length) fail('Lens retained_directories 只能登记原有 assets 和 assets/skill-lens 目录');
  const physicalDirectories = new Set(directories);
  for (const name of lookup.keys()) for (const parent of parents(name)) physicalDirectories.add(parent);
  if (retained.some(name => !physicalDirectories.has(name))) fail('Lens 登记的原有目录并不存在');
  if (!isSha(manifest.current_source_fingerprint)) fail('Lens 当前来源指纹无效');
  if (!Array.isArray(manifest.files) || manifest.files.length !== 3) fail('Lens manifest 必须完整登记 current、origin、graph 三个派生文件');
  const roles = new Set(); let total = 0;
  for (const entry of manifest.files) {
    if (!sameKeys(entry, ['path', 'role', 'bytes', 'sha256'])) fail('Lens 派生文件登记字段无效');
    if (typeof entry.role !== 'string' || !own(LENS_PATHS, entry.role) || roles.has(entry.role) || entry.path !== LENS_PATHS[entry.role]) fail('Lens 派生文件路径或角色重复/不合法');
    roles.add(entry.role);
    const data = lookup.get(entry.path), maximum = entry.role === 'graph' ? MAX_LENS_GRAPH_BYTES : MAX_LENS_HTML_BYTES;
    if (!data || !Number.isInteger(entry.bytes) || entry.bytes !== data.length || data.length > maximum || !isSha(entry.sha256) || sha256(data) !== entry.sha256) fail(`Lens 派生文件缺失、超限或 SHA-256 不符：${entry.path}`);
    total += data.length;
  }
  if (total > MAX_LENS_TOTAL_BYTES) fail('Lens 派生文件总计超过 128 MiB');
  const origin = lookup.get(LENS_PATHS.origin), originData = lensHtmlData(origin, '首次原图');
  const originPortability = originData.portability || {};
  if (!plainObject(originPortability) || (own(originPortability, 'origin_base64') && originPortability.origin_base64 !== null) || ![undefined, null, false].includes(originPortability.managed)) fail('首次原图必须是叶子，不能嵌入自身或先前 Lens 阅读页');
  const currentData = lensHtmlData(lookup.get(LENS_PATHS.current), '当前阅读页'), currentState = currentData.portability;
  if (!plainObject(currentState) || currentState.managed !== true || typeof currentState.origin_base64 !== 'string') fail('当前阅读页缺少单层原图载荷');
  const base64 = currentState.origin_base64;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64)) fail('当前阅读页原图载荷不是有效 Base64');
  const embedded = Buffer.from(base64, 'base64'), originSha = sha256(origin);
  if (!embedded.equals(origin) || currentState.origin_sha256 !== originSha) fail('当前阅读页携带的原图与 origin.html 不一致');
  let graph; try { graph = parseJson(decodeUtf8(lookup.get(LENS_PATHS.graph)), true); } catch { fail('Lens graph.json 无效'); }
  if (!plainObject(graph) || !isSha(graph.source_fingerprint) || !deepEqual(currentData.graph, graph)) fail('Lens graph.json 与当前阅读页的语义图不一致');
  const skill = lookup.get('SKILL.md'), navigation = Buffer.from(LENS_NAVIGATION_BLOCK);
  if (!skill || skill.length < navigation.length || !skill.subarray(skill.length - navigation.length).equals(navigation) || countBytes(skill, Buffer.from('<!-- skill-lens:view-links:v1 -->')) !== 1 || countBytes(skill, Buffer.from('<!-- /skill-lens:view-links:v1 -->')) !== 1) fail('受管理 Skill 的固定查看入口缺失、重复或已被改动；不忽略业务正文');
  metadata['SKILL.md'] = { source_sha256: sha256(skill), source_bytes: skill.length };
  const core = payload.filter(([name]) => !LENS_MANAGED_PATHS.has(name)).map(([name, data]) => [name, name === 'SKILL.md' ? skill.subarray(0, skill.length - navigation.length) : data]);
  const coreDirectories = new Set([...directories].filter(name => !['assets', LENS_DIRECTORY].includes(name)));
  for (const name of retained) coreDirectories.add(name);
  return [core, coreDirectories, { managed: true, origin_base64: origin.toString('base64'), origin_sha256: originSha, manifest, graph_source_fingerprint: graph.source_fingerprint }, metadata];
}
/** Python str.splitlines(keepends=True), measured in JS UTF-16 offsets. */
export function splitLines(text) {
  const lines = []; let start = 0;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if ([10, 11, 12, 13, 28, 29, 30, 133, 0x2028, 0x2029].includes(code)) {
      if (code === 13 && text.charCodeAt(at + 1) === 10) at++;
      lines.push(text.slice(start, at + 1)); start = at + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}
function makePathRegistry() {
  const records = new Map(), explicit = new Set();
  return (name, directory) => {
    const names = [...parents(name).reverse().map(parent => [parent, true, false]), [name, directory, true]];
    for (const [item, isDirectory, isExplicit] of names) {
      const key = casefold(item), existing = records.get(key);
      if (existing && (existing.name !== item || existing.directory !== isDirectory || (isExplicit && explicit.has(key)))) fail(`包中有重复或大小写冲突路径: ${name}`);
      if (!existing) records.set(key, { name: item, directory: isDirectory });
      if (isExplicit) explicit.add(key);
    }
  };
}
export function sourceFingerprint(snapshot) {
  const directories = new Set(snapshot.directories || []);
  for (const name of [...snapshot.files.map(file => file.path), ...directories]) for (const parent of parents(name)) directories.add(parent);
  // Key order matches Python json.dumps(sort_keys=True, ensure_ascii=False).
  const identity = { directories: sorted(directories), files: [...snapshot.files].sort((a, b) => codepointCompare(a.path, b.path)).map(file => ({ path: file.path, sha256: file.sha256 })), schema_version: 1 };
  return sha256(Buffer.from(JSON.stringify(identity), 'utf8'));
}
function validateManualManifest(snapshot) {
  const lookup = new Map(snapshot.files.map(file => [file.path, file])), provenance = lookup.get('provenance.json');
  if (!provenance || provenance.text === null) return;
  let manifest; try { manifest = parseJson(provenance.text, true); } catch { return; }
  if (!plainObject(manifest) || manifest.source_kind !== 'manual') return;
  if (manifest.schema_version !== 1) fail('不支持的手册 provenance schema_version');
  const sources = manifest.sources, readonly = manifest.readonly_files;
  if (!Array.isArray(sources) || sources.length !== 2 || !Array.isArray(readonly)) fail('手册 provenance 须有两条 sources 及 readonly_files');
  const expected = new Set(['provenance.json']), roles = new Set();
  for (const source of sources) {
    if (!plainObject(source)) fail('手册 source 须为对象');
    const name = safeName(source.file), role = source.role;
    if (roles.has(role) || !['readable', 'original'].includes(role)) fail('手册 sources 须各有一条 readable 与 original');
    roles.add(role);
    if (role === 'readable' && name !== 'references/manual-readable.md') fail('手册 readable 路径须为 references/manual-readable.md');
    if (role === 'original' && !/^references\/manual-original\.[a-z0-9]{1,12}$/u.test(name)) fail('手册 original 路径不符合约定');
    if (!lookup.has(name) || !isSha(source.sha256) || lookup.get(name).sha256 !== source.sha256) fail(`手册只读证据缺失或哈希不符: ${name}`);
    if (role === 'readable' && lookup.get(name).text === null) fail('手册 readable 须为 UTF-8 文本');
    expected.add(name);
  }
  if (readonly.some(name => typeof name !== 'string') || readonly.length !== expected.size || new Set(readonly).size !== expected.size || readonly.some(name => !expected.has(name))) fail('手册 readonly_files 必须完整保护原件、转写及 provenance.json');
  snapshot.source_kind = 'manual'; snapshot.readonly_files = sorted(expected);
}
export function snapshotSkill(input) {
  const source = path.resolve(input); checkAncestors(source);
  let payload = [], directories = new Set(), sourceMode = 'directory', rootName = path.basename(source), total = 0;
  const register = makePathRegistry();
  function add(name, data) {
    name = safeName(name); register(name, false);
    if (data.length > fileLimit(name)) fail(`单文件超过允许尺寸: ${name}`);
    total += data.length;
    if (total > MAX_TOTAL_BYTES + MAX_LENS_TOTAL_BYTES + MAX_LENS_MANIFEST_BYTES || payload.length >= MAX_FILES + 4) fail('包超过核心与受管理 Lens 的总尺寸或文件数限制');
    payload.push([name, data]);
  }
  function addDirectory(name) { safeName(name); register(name, true); directories.add(name); }
  const sourceInfo = checkPlain(source);
  if (sourceInfo.isDirectory()) {
    let skillInfo; try { skillInfo = checkPlain(path.join(source, 'SKILL.md')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!skillInfo?.isFile()) fail('目录根部须有 SKILL.md');
    const walk = (current, prefix = '') => {
      const items = fs.readdirSync(current).map(name => ({ name, full: path.join(current, name), info: checkPlain(path.join(current, name)) }));
      const children = items.filter(item => item.info.isDirectory()).sort((a, b) => codepointCompare(a.name, b.name));
      const names = items.filter(item => !item.info.isDirectory()).sort((a, b) => codepointCompare(a.name, b.name));
      for (const child of children) addDirectory(prefix + child.name);
      for (const child of names) {
        if (!child.info.isFile()) fail(`仅支持常规文件: ${child.full}`);
        const relative = prefix + child.name;
        if (child.info.size > fileLimit(relative)) fail(`单文件超过允许尺寸: ${child.name}`);
        add(relative, fs.readFileSync(child.full));
      }
      for (const child of children) walk(child.full, `${prefix}${child.name}/`);
    };
    walk(source);
  } else if (sourceInfo.isFile() && ['.zip', '.skill'].includes(path.extname(source).toLowerCase())) {
    sourceMode = 'zip';
    if (sourceInfo.size > 256 * 1024 * 1024) fail('ZIP 压缩包超过 256 MiB 的读取限制');
    let entries;
    try { entries = readZip(fs.readFileSync(source), { safeName, fileLimit, maxTotalBytes: MAX_TOTAL_BYTES + MAX_LENS_TOTAL_BYTES + MAX_LENS_MANIFEST_BYTES }); }
    catch (error) { if (error instanceof ZipError) throw new LensError(error.message); throw error; }
    // Detect duplicates and alias collisions before selecting the Skill root.
    const registerArchive = makePathRegistry();
    for (const entry of entries) registerArchive(entry.name, entry.directory);
    const skills = entries.filter(entry => !entry.directory && entry.name.split('/').at(-1) === 'SKILL.md');
    if (skills.length !== 1) fail('ZIP 中必须恰有一个 SKILL.md；多 Skill 集合请先选择一个包');
    const prefix = skills[0].name.slice(0, -'SKILL.md'.length);
    rootName = prefix ? prefix.slice(0, -1).split('/').at(-1) : path.basename(source, path.extname(source));
    for (const entry of entries) {
      if (prefix && `${entry.name}/` === prefix && entry.directory) continue;
      if (prefix && !entry.name.startsWith(prefix)) fail('ZIP 包含 Skill 根目录之外的文件；请先明确要可视化的包');
      const local = entry.name.slice(prefix.length);
      if (entry.directory) addDirectory(local); else add(local, entry.data);
    }
  } else if (sourceInfo.isFile() && path.basename(source) === 'SKILL.md') {
    sourceMode = 'single-file'; rootName = path.basename(path.dirname(source)) || 'custom-skill';
    if (sourceInfo.size > MAX_FILE_BYTES) fail('单文件超过允许尺寸: SKILL.md');
    add('SKILL.md', fs.readFileSync(source));
  } else fail('--skill 只接收 Skill 目录、SKILL.md、.zip 或 .skill 包');
  let portability, metadata;
  [payload, directories, portability, metadata] = extractLensBundle(payload, directories);
  total = payload.reduce((sum, [, data]) => sum + data.length, 0);
  if (total > MAX_TOTAL_BYTES || payload.length > MAX_FILES) fail('核心包超过限制：512 个文件或总计 32 MiB');
  if (payload.some(([, data]) => data.length > MAX_FILE_BYTES)) fail('未受管理的核心文件超过 8 MiB；同名 HTML 不会自动变成受管理视图');
  const files = payload.sort(([a], [b]) => codepointCompare(a, b)).map(([name, data]) => {
    const item = { path: name, bytes: data.length, sha256: sha256(data), base64: data.toString('base64'), ...(metadata[name] || {}) };
    try { item.text = decodeUtf8(data); item.line_count = splitLines(item.text).length; } catch { item.text = null; item.line_count = null; }
    return item;
  });
  const result = { name: rootName, mode: sourceMode, files, directories: sorted(directories), total_bytes: total, source_kind: 'skill', readonly_files: [], portability };
  validateManualManifest(result); result.source_fingerprint = sourceFingerprint(result);
  if (portability.managed) portability.stale = portability.manifest.current_source_fingerprint !== result.source_fingerprint || portability.graph_source_fingerprint !== result.source_fingerprint;
  return result;
}
export function agentSnapshot(snapshot) {
  const result = Object.fromEntries(Object.entries(snapshot).filter(([key]) => !['files', 'portability'].includes(key)));
  if (own(snapshot, 'portability')) result.portability = Object.fromEntries(Object.entries(snapshot.portability).filter(([key]) => key !== 'origin_base64'));
  const protectedFiles = new Set(snapshot.readonly_files || []);
  result.files = snapshot.files.map(file => {
    const readable = file.text !== null, item = {};
    for (const key of ['path', 'bytes', 'sha256', 'line_count']) item[key] = file[key];
    for (const key of ['source_sha256', 'source_bytes']) if (own(file, key)) item[key] = file[key];
    item.readable = readable; item.readonly = protectedFiles.has(file.path);
    if (readable) item.numbered_lines = splitLines(file.text).map((line, i) => ({ line: i + 1, text: line.replace(/[\r\n]+$/u, '') }));
    return item;
  });
  return result;
}
export function validateGraph(inputGraph, snapshot, { requireSourceFingerprint = false } = {}) {
  if (!plainObject(inputGraph) || !Array.isArray(inputGraph.nodes) || !inputGraph.nodes.length) fail('graph 必须是含非空 nodes 数组的对象');
  if (inputGraph.nodes.length > 160) fail('单图最多 160 个节点；请用阶段分组降低密度');
  const fingerprint = sourceFingerprint(snapshot), supplied = inputGraph.source_fingerprint;
  if (supplied === undefined || supplied === null) {
    if (requireSourceFingerprint) fail('graph 缺少 source_fingerprint；请从解读所用快照复制来源指纹。不得用当前指纹替换旧图来跳过重新阅读');
  } else if (!isSha(supplied)) fail('graph.source_fingerprint 须为快照中的 64 位 SHA-256 来源指纹');
  else if (supplied !== fingerprint) fail('图与来源版本不一致：原文或包结构已变化。请重新快照、阅读并生成图，不得仅替换旧图的指纹');
  const lookup = new Map(snapshot.files.map(file => [file.path, file])), ids = new Set(), blocks = [];
  let graph; try { graph = JSON.parse(JSON.stringify(inputGraph)); } catch { fail('graph 须为可序列化 JSON 对象'); }
  defaults(graph, { title: snapshot.name, summary: '依据 Skill 原文解读的预计流程', edges: [], gaps: [], demo: false, source_kind: snapshot.source_kind || 'skill' });
  if (!['skill', 'manual'].includes(graph.source_kind)) fail('graph.source_kind 仅支持 skill/manual');
  if (graph.source_kind !== (snapshot.source_kind || 'skill')) fail('graph.source_kind 与来源包不符；手册模式须先用 prepare_manual.mjs 生成并校验 provenance.json');
  const protectedFiles = new Set(snapshot.readonly_files || []);
  if (!Array.isArray(graph.edges)) fail('graph.edges 须为数组');
  for (const key of ['title', 'summary']) if (typeof graph[key] !== 'string') fail(`graph.${key} 须为字符串`);
  if (typeof graph.demo !== 'boolean' || !Array.isArray(graph.gaps) || graph.gaps.some(value => typeof value !== 'string')) fail('demo 须为布尔值，gaps 须为字符串数组');
  for (const node of graph.nodes) {
    if (!plainObject(node) || typeof node.id !== 'string' || !node.id || ids.has(node.id)) fail('node.id 须为非空、唯一字符串');
    ids.add(node.id);
    defaults(node, { label: node.id, kind: 'step', summary: '', evidence: 'unknown', inputs: [], outputs: [], source_refs: [], evidence_refs: [], actor: 'unknown' });
    if (!['agent', 'human', 'tool', 'unknown'].includes(node.actor)) fail('node.actor 仅支持 agent/human/tool/unknown');
    for (const key of ['label', 'kind', 'summary']) if (typeof node[key] !== 'string') fail(`节点 ${node.id} 的 ${key} 须为字符串`);
    if (!['explicit', 'inferred', 'unknown'].includes(node.evidence)) fail(`未知 evidence: ${node.evidence}`);
    for (const key of ['inputs', 'outputs']) if (!Array.isArray(node[key]) || node[key].some(value => typeof value !== 'string')) fail('inputs/outputs 须为字符串数组');
    if (!Array.isArray(node.source_refs)) fail('source_refs 须为数组');
    node.block_ids = [];
    for (const ref of node.source_refs) {
      if (!plainObject(ref)) fail('source_ref 须为对象');
      const name = safeName(ref.file), start = ref.start_line, end = ref.end_line;
      if (protectedFiles.has(name)) fail(`手册原件、转写与来源记录只读，不能成为 source_refs 编辑区: ${name}`);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) fail(`无效原文行范围: ${name} ${start}-${end}`);
      if (!lookup.has(name)) fail(`原文映射文件不存在: ${name}`);
      const text = lookup.get(name).text;
      if (text === null) fail(`原文映射仅支持 UTF-8 文本: ${name}`);
      const lines = splitLines(text);
      if (end > lines.length) fail(`原文映射越界: ${name} 只有 ${lines.length} 行`);
      let block = blocks.find(item => item.file === name && item.start_line === start && item.end_line === end);
      if (!block) {
        for (const old of blocks) if (old.file === name && Math.max(start, old.start_line) <= Math.min(end, old.end_line)) fail(`原文映射部分重叠: ${name} ${start}-${end} 与 ${old.start_line}-${old.end_line}；请共享同一范围或拆成不重叠范围`);
        const original = lines.slice(start - 1, end).join(''), prefix = lines.slice(0, start - 1).join('');
        block = { id: `b${blocks.length + 1}`, file: name, start_line: start, end_line: end, start: prefix.length, end: prefix.length + original.length, original, node_ids: [] }; blocks.push(block);
      }
      if (!block.node_ids.includes(node.id)) block.node_ids.push(node.id);
      if (!node.block_ids.includes(block.id)) node.block_ids.push(block.id);
    }
    if (!Array.isArray(node.evidence_refs)) fail('evidence_refs 须为数组');
    node.evidence_spans = [];
    for (const ref of node.evidence_refs) {
      if (!plainObject(ref)) fail('evidence_ref 须为对象');
      const name = safeName(ref.file), start = ref.start_line, end = ref.end_line;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) fail(`无效证据行范围: ${name} ${start}-${end}`);
      if (!lookup.has(name) || lookup.get(name).text === null) fail(`只读证据须指向已存在的 UTF-8 文本: ${name}`);
      if (graph.source_kind === 'manual' && (!protectedFiles.has(name) || name === 'provenance.json')) fail('手册 evidence_refs 须指向受保护的手册原文，不可指向候选指令或 provenance');
      const lines = splitLines(lookup.get(name).text);
      if (end > lines.length) fail(`只读证据行范围越界: ${name}`);
      node.evidence_spans.push({ file: name, start_line: start, end_line: end, text: lines.slice(start - 1, end).join(''), sha256: lookup.get(name).sha256 });
    }
  }
  for (const edge of graph.edges) {
    if (!plainObject(edge) || !ids.has(edge.from) || !ids.has(edge.to)) fail('edge 必须引用已存在节点的 from/to');
    defaults(edge, { label: '', kind: 'flow' });
    if (!['flow', 'condition', 'reference'].includes(edge.kind) || typeof edge.label !== 'string') fail('edge.kind 仅支持 flow/condition/reference，label 须为字符串');
  }
  return [graph, blocks];
}
function safeJson(data) { return JSON.stringify(data).replace(/</gu, '\\u003c').replace(/>/gu, '\\u003e').replace(/&/gu, '\\u0026').replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029'); }
function physicalKey(filename) { const value = path.resolve(filename); return process.platform === 'win32' ? casefold(value) : value; }
function refuseInputOutput(source, destination) {
  checkAncestors(destination);
  const src = physicalKey(source), dst = physicalKey(destination), relative = path.relative(src, dst);
  if (src === dst || (fs.statSync(source).isDirectory() && relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) fail('输出须放在输入 Skill 之外，不能覆盖原件或写回原包');
  try { fs.lstatSync(destination); fail(`输出已存在，保留原文件。请换一个输出名: ${destination}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export function buildLens({ skill, graph: graphInput, output, snapshot: snapshotOutput } = {}) {
  if (!skill || Boolean(graphInput) !== Boolean(output) || (!output && !snapshotOutput)) fail('--graph 与 --output 须一起提供；或仅提供 --snapshot');
  const source = path.resolve(skill), snapshot = snapshotSkill(source), writes = [];
  const graphPath = typeof graphInput === 'string' ? path.resolve(graphInput) : null;
  if (snapshotOutput) {
    const target = path.resolve(snapshotOutput); refuseInputOutput(source, target);
    if (graphPath && physicalKey(target) === physicalKey(graphPath)) fail('不能覆盖 graph 输入文件');
    writes.push([target, JSON.stringify(agentSnapshot(snapshot), null, 2)]);
  }
  if (output) {
    const target = path.resolve(output); refuseInputOutput(source, target);
    if (graphPath && physicalKey(target) === physicalKey(graphPath)) fail('不能覆盖 graph 输入文件');
    let graph = graphInput;
    if (graphPath) {
      checkAncestors(graphPath); const info = checkPlain(graphPath);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) fail('graph 输入须为不超过 8 MiB 的常规 JSON 文件');
      try { graph = parseJson(decodeUtf8(fs.readFileSync(graphPath)), true); } catch { fail('graph 输入不是有效的 UTF-8 JSON'); }
    }
    const [validated, blocks] = validateGraph(graph, snapshot, { requireSourceFingerprint: true });
    const packageData = Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== 'portability'));
    const data = { version: '0.7.1', graph: validated, package: packageData, blocks, drafts: {}, portability: snapshot.portability || { managed: false, origin_base64: null, origin_sha256: null, manifest: null } };
    const templatePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/lens.html');
    const template = decodeUtf8(fs.readFileSync(templatePath));
    if (template.split('__LENS_DATA__').length !== 2) fail('Lens HTML 模板须含唯一的 __LENS_DATA__ 占位符');
    writes.push([target, template.replace('__LENS_DATA__', () => safeJson(data))]);
  }
  const keys = writes.map(([target]) => physicalKey(target));
  if (new Set(keys).size !== keys.length) fail('不同输出不可使用同一路径');
  const created = [];
  try {
    for (const [target, content] of writes) {
      checkAncestors(target); fs.mkdirSync(path.dirname(target), { recursive: true }); checkAncestors(target);
      const descriptor = fs.openSync(target, 'wx'); created.push(target);
      try { fs.writeFileSync(descriptor, content, { encoding: 'utf8' }); } finally { fs.closeSync(descriptor); }
    }
  } catch (error) {
    for (const target of created) { try { fs.unlinkSync(target); } catch { /* retain original failure */ } }
    throw error;
  }
  return { ok: true, files: snapshot.files.length, source_mode: snapshot.mode, outputs: writes.map(([target]) => target), note: snapshot.mode === 'single-file' ? '单文件输入可能缺失依赖' : '仅静态解读，不执行输入 Skill' };
}
export function main(argv = process.argv.slice(2)) {
  try {
    const options = {};
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === '--help' || flag === '-h') { process.stdout.write('用法: node build_lens.mjs --skill <目录|SKILL.md|ZIP|.skill> [--snapshot <新JSON>] [--graph <JSON> --output <新HTML>]\n'); return 0; }
      if (!['--skill', '--snapshot', '--graph', '--output'].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) fail(`无效或缺少值的参数: ${flag}`);
      if (own(options, flag.slice(2))) fail(`参数不可重复: ${flag}`);
      options[flag.slice(2)] = argv[++i];
    }
    process.stdout.write(`${JSON.stringify(buildLens(options))}\n`); return 0;
  } catch (error) { process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`); return 1; }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = main();
