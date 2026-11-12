#!/usr/bin/env node
/** Platform adapter: one JSON request, one isolated administrator-assigned job directory. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { snapshotSkill, agentSnapshot, buildLens, safeName, checkAncestors } from './build_lens.mjs';
import { prepareManual } from './prepare_manual.mjs';

const REQUEST_LIMIT = 4 * 1024 * 1024;
const fields = {
  snapshot: ['action', 'skill', 'snapshot'],
  read_source: ['action', 'skill', 'source_fingerprint', 'file', 'start_line', 'end_line'],
  prepare_manual: ['action', 'manual', 'draft', 'draft_text', 'output', 'original'],
  build: ['action', 'skill', 'graph', 'output'],
};
const mime = name => name.endsWith('.html') ? 'text/html' : name.endsWith('.json') ? 'application/json' : /\.(md|txt)$/i.test(name) ? 'text/plain' : 'application/octet-stream';

function jobPath(workspace, relative) {
  if (typeof relative !== 'string') throw new Error('路径必须是当前任务目录内的相对路径');
  const clean = safeName(relative);
  const absolute = path.resolve(workspace, ...clean.split('/'));
  const back = path.relative(workspace, absolute);
  if (!back || back === '..' || back.startsWith('..' + path.sep) || path.isAbsolute(back)) throw new Error('路径须位于本任务目录内');
  checkAncestors(absolute);
  return absolute;
}

function artifact(workspace, file) {
  const stat = fs.statSync(file);
  return { path: path.relative(workspace, file).split(path.sep).join('/'), mime_type: mime(file), bytes: stat.size };
}

function storeToolInput(workspace, extension, content) {
  const relative = 'work/skill-lens-input-' + randomUUID() + extension;
  const target = jobPath(workspace, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { flag: 'wx', encoding: 'utf8' });
  return target;
}

export function dispatchRequest(request, { workspace } = {}) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new Error('平台须指定存在的绝对任务目录 --workspace');
  const base = path.resolve(workspace);
  checkAncestors(base);
  if (!fs.statSync(base).isDirectory()) throw new Error('任务目录须为常规目录');
  if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.action !== 'string' || !Object.hasOwn(fields, request.action)) throw new Error('action 仅支持 snapshot / read_source / prepare_manual / build');
  if (Object.keys(request).some(key => !fields[request.action].includes(key))) throw new Error('请求包含未支持字段');
  if (request.action === 'snapshot') {
    const source = jobPath(base, request.skill), target = jobPath(base, request.snapshot);
    const result = buildLens({ skill: source, snapshot: target });
    const context = agentSnapshot(snapshotSkill(source));
    return { ok: true, action: request.action, files: context.files.map(({ numbered_lines, ...file }) => file), directories: context.directories, source_fingerprint: context.source_fingerprint, source_kind: context.source_kind, source_mode: result.source_mode, artifacts: [artifact(base, target)], note: '用 read_source 按文件及行范围阅读，源业务未执行。' };
  }
  if (request.action === 'read_source') {
    if (typeof request.source_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(request.source_fingerprint)) throw new Error('须提供 snapshot 返回的来源指纹');
    const snapshot = snapshotSkill(jobPath(base, request.skill));
    if (snapshot.source_fingerprint !== request.source_fingerprint) throw new Error('来源已变化，请重新快照并复核，不能沿用旧映射');
    const selected = agentSnapshot(snapshot).files.find(file => file.path === safeName(request.file));
    if (!selected) throw new Error('源包中没有这个文件');
    if (!selected.readable) return { ok: true, action: request.action, source_fingerprint: snapshot.source_fingerprint, file: selected, note: '二进制附件按原字节保留，未作语义读取。' };
    const start = request.start_line ?? 1, end = request.end_line ?? Math.min(selected.line_count, start + 199);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > selected.line_count || end - start >= 500) throw new Error('行范围须在文件内，单次最多500行；空文件没有可读行');
    const lines = selected.numbered_lines.slice(start - 1, end);
    if (Buffer.byteLength(JSON.stringify(lines)) > 256 * 1024) throw new Error('所选正文超过256 KiB，请缩小范围');
    const { numbered_lines, ...metadata } = selected;
    return { ok: true, action: request.action, source_fingerprint: snapshot.source_fingerprint, file: metadata, start_line: start, end_line: end, numbered_lines: lines };
  }
  if (request.action === 'prepare_manual') {
    if (Object.hasOwn(request, 'draft') === Object.hasOwn(request, 'draft_text')) throw new Error('draft 路径与 draft_text 正文须且只能提供一个');
    if (Object.hasOwn(request, 'draft_text') && typeof request.draft_text !== 'string') throw new Error('draft_text 须为候选 SKILL.md 字符串');
    const output = jobPath(base, request.output);
    const draft = Object.hasOwn(request, 'draft') ? jobPath(base, request.draft) : storeToolInput(base, '.md', request.draft_text);
    const result = prepareManual({ manual: jobPath(base, request.manual), draft, output, original: request.original === undefined ? undefined : jobPath(base, request.original) });
    const snapshot = snapshotSkill(output);
    const artifacts = snapshot.files.map(file => artifact(base, path.join(output, ...file.path.split('/'))));
    return { ok: true, action: request.action, files: result.files, source_kind: 'manual', skill: request.output, artifacts, note: result.note };
  }
  const target = jobPath(base, request.output);
  const graph = request.graph && typeof request.graph === 'object' && !Array.isArray(request.graph) ? storeToolInput(base, '.json', JSON.stringify(request.graph)) : jobPath(base, request.graph);
  const result = buildLens({ skill: jobPath(base, request.skill), graph, output: target });
  return { ok: true, action: request.action, files: result.files, source_mode: result.source_mode, artifacts: [artifact(base, target)], note: '平台将 HTML 登记为可下载成果；员工用浏览器查看和修改。' };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== '--workspace') {
    process.stdout.write(JSON.stringify({ ok: false, code: 'CONFIGURATION_ERROR', error: '用法：node scripts/platform_tool.mjs --workspace <平台分配的绝对任务目录>；stdin 为一条 JSON 请求。' }) + '\n');
    return 1;
  }
  try {
    const chunks = []; let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > REQUEST_LIMIT) throw new Error('请求 JSON 超过 4 MiB；大正文应通过任务文件传递');
      chunks.push(chunk);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    const request = JSON.parse(text);
    process.stdout.write(JSON.stringify(dispatchRequest(request, { workspace: argv[1] })) + '\n');
    return 0;
  } catch (error) {
    const message = String(error.message || error).split(path.resolve(argv[1])).join('<job>').slice(0, 2000);
    process.stdout.write(JSON.stringify({ ok: false, code: 'REQUEST_FAILED', error: message }) + '\n');
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
