import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { snapshotSkill, agentSnapshot, validateGraph, buildLens, safeName, splitLines, LensError, checkAncestors } from './build_lens.mjs';
import { crc32 } from './zip.mjs';

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../evaluation/builder-dev');
fs.mkdirSync(base, { recursive: true });
const work = fs.mkdtempSync(path.join(base, 'run-'));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function source(name = 'source', skill = '\uFEFFfirst🙂\r\n第二行\r第三行\nlast') {
  const directory = path.join(work, name); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'SKILL.md'), skill);
  return directory;
}
function zip(entries) {
  const locals = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name), data = Buffer.from(entry.data || ''), method = entry.method || 0;
    const compressed = method === 8 ? deflateRawSync(data) : data, flags = entry.flags ?? (entry.descriptor ? 0x808 : 0x800), crc = crc32(data);
    const local = Buffer.alloc(30), record = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(flags, 8); record.writeUInt16LE(method, 10); record.writeUInt32LE(crc, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(entry.attributes || 0, 38); record.writeUInt32LE(offset, 42);
    let descriptor = Buffer.alloc(0);
    if (entry.descriptor) {
      descriptor = Buffer.alloc(entry.descriptor === 'signed' ? 16 : 12); const start = descriptor.length - 12;
      if (start) descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc, start); descriptor.writeUInt32LE(compressed.length, start + 4); descriptor.writeUInt32LE(data.length, start + 8);
      local.fill(0, 14, 26);
    }
    locals.push(local, name, compressed, descriptor); central.push(record, name); offset += local.length + name.length + compressed.length + descriptor.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function archive(name, entries) { const filename = path.join(work, name); fs.writeFileSync(filename, zip(entries)); return filename; }
function graph(snapshot, refs = [{ file: 'SKILL.md', start_line: 1, end_line: 1 }]) { return { source_fingerprint: snapshot.source_fingerprint, nodes: [{ id: 'n1', source_refs: refs }] }; }

test('BOM, byte preservation, Python splitlines and UTF-16 source blocks', () => {
  const directory = source(), bytes = fs.readFileSync(path.join(directory, 'SKILL.md'));
  fs.writeFileSync(path.join(directory, 'binary.bin'), Buffer.from([0xff, 0xfe, 0x00]));
  const snapshot = snapshotSkill(directory), skill = snapshot.files.find(file => file.path === 'SKILL.md');
  assert.equal(skill.text.charCodeAt(0), 0xfeff); assert.deepEqual(Buffer.from(skill.base64, 'base64'), bytes); assert.equal(skill.sha256, hash(bytes)); assert.equal(skill.line_count, 4);
  assert.equal(snapshot.files.find(file => file.path === 'binary.bin').text, null);
  const [normalized, blocks] = validateGraph(graph(snapshot, [{ file: 'SKILL.md', start_line: 2, end_line: 3 }]), snapshot, { requireSourceFingerprint: true });
  assert.equal(blocks[0].start, '\uFEFFfirst🙂\r\n'.length); assert.equal(blocks[0].original, '第二行\r第三行\n'); assert.equal(blocks[0].end, '\uFEFFfirst🙂\r\n第二行\r第三行\n'.length);
  assert.deepEqual(normalized.nodes[0].block_ids, ['b1']);
  assert.equal(agentSnapshot(snapshot).files[0].numbered_lines[0].text, '\uFEFFfirst🙂');
  assert.deepEqual(splitLines('a\vb\fc\x1cd\x1de\x1ef\x85g\u2028h\u2029'), ['a\v', 'b\f', 'c\x1c', 'd\x1d', 'e\x1e', 'f\x85', 'g\u2028', 'h\u2029']);
  assert.deepEqual(splitLines(''), []); assert.deepEqual(splitLines('\r\n'), ['\r\n']);
});

test('directory, ZIP, .skill and single-file share byte-bound identity; empty directories matter', () => {
  const directory = source('equivalence', 'same\n'), single = snapshotSkill(path.join(directory, 'SKILL.md'));
  assert.equal(single.mode, 'single-file');
  assert.equal(snapshotSkill(directory).source_fingerprint, single.source_fingerprint);
  fs.mkdirSync(path.join(directory, 'empty'));
  const packaged = archive('equivalence.skill', [{ name: 'root/' }, { name: 'root/SKILL.md', data: 'same\n', method: 8 }, { name: 'root/empty/' }]);
  const dirSnapshot = snapshotSkill(directory), zipSnapshot = snapshotSkill(packaged);
  assert.equal(zipSnapshot.mode, 'zip'); assert.equal(dirSnapshot.source_fingerprint, zipSnapshot.source_fingerprint); assert.notEqual(single.source_fingerprint, dirSnapshot.source_fingerprint);
});

test('graph strict binding, shared exact ranges, overlaps and missing mappings', () => {
  const snapshot = snapshotSkill(source('mapping', 'one\ntwo\nthree\n'));
  const input = graph(snapshot, [{ file: 'SKILL.md', start_line: 1, end_line: 2 }]);
  input.nodes.push({ id: 'n2', source_refs: [{ file: 'SKILL.md', start_line: 1, end_line: 2 }] });
  const [normalized, blocks] = validateGraph(input, snapshot, { requireSourceFingerprint: true }); assert.equal(blocks.length, 1); assert.deepEqual(blocks[0].node_ids, ['n1', 'n2']); assert.deepEqual(normalized.nodes[1].block_ids, ['b1']);
  assert.throws(() => validateGraph({ nodes: [{ id: 'x' }] }, snapshot, { requireSourceFingerprint: true }), /缺少 source_fingerprint/);
  assert.throws(() => validateGraph({ ...input, source_fingerprint: '0'.repeat(64) }, snapshot), /来源版本不一致/);
  input.nodes[1].source_refs[0].start_line = 2; assert.throws(() => validateGraph(input, snapshot), /部分重叠/);
  assert.throws(() => validateGraph(graph(snapshot, [{ file: 'missing.md', start_line: 1, end_line: 1 }]), snapshot), /不存在/);
  assert.throws(() => validateGraph(graph(snapshot, [{ file: 'SKILL.md', start_line: 4, end_line: 4 }]), snapshot), /越界/);
});

test('functional regions preserve source mappings and graph semantics; legacy graphs remain accepted', () => {
  const snapshot = snapshotSkill(source('regions-good', 'prepare\nprocess\nfinish\n'));
  const input = graph(snapshot);
  input.nodes = ['ready', 'work', 'done'].map((id, index) => ({ id, region_id: ['prepare', 'work', 'result'][index], source_refs: [{ file: 'SKILL.md', start_line: index + 1, end_line: index + 1 }] }));
  input.edges = [{ from: 'ready', to: 'work', kind: 'flow', label: '处理' }, { from: 'work', to: 'done', kind: 'condition', label: '完成后' }];
  input.regions = [{ id: 'prepare', label: '先准备什么', description: '查看需要的材料' }, { id: 'work', label: '按步骤处理' }, { id: 'result', label: '最后得到什么', description: '查看交付内容' }];
  const before = JSON.stringify(input), [normalized, blocks] = validateGraph(input, snapshot);
  assert.equal(JSON.stringify(input), before, 'validator must not mutate graph authored by Agent');
  assert.deepEqual(normalized.edges, input.edges);
  assert.deepEqual(normalized.nodes.map(node => node.region_id), ['prepare', 'work', 'result']);
  assert.deepEqual(normalized.regions.map(region => region.id), ['prepare', 'work', 'result']);
  assert.equal(blocks.length, 3); assert.equal(blocks[1].original, 'process\n');
  assert.doesNotThrow(() => validateGraph(graph(snapshot), snapshot));
});

test('invalid functional-area definitions fail before producing a misleading graph', () => {
  const snapshot = snapshotSkill(source('regions-invalid', 'one\ntwo\n'));
  const valid = () => ({ ...graph(snapshot), regions: [{ id: 'work', label: '按步骤处理', description: '查看处理过程' }], nodes: [{ id: 'n1', region_id: 'work', source_refs: [{ file: 'SKILL.md', start_line: 1, end_line: 1 }] }] });
  const cases = [
    value => { value.regions = null; },
    value => { value.regions = []; },
    value => { value.regions = {}; },
    value => { value.regions = [null]; },
    value => { value.regions[0].id = ''; },
    value => { value.regions[0].label = ' '; },
    value => { value.regions[0].description = 12; },
    value => { value.regions.push({ id: 'work', label: '重复' }); },
    value => { value.regions.push({ id: 'unused', label: '没有内容的分区' }); },
    value => { delete value.nodes[0].region_id; },
    value => { value.nodes[0].region_id = 'unknown'; },
    value => { value.nodes[0].region_id = ['work']; },
    value => { delete value.regions; },
    value => { value.regions = Array.from({ length: 17 }, (_, index) => ({ id: String(index), label: String(index) })); },
  ];
  cases.forEach((change, index) => { const value = valid(); change(value); assert.throws(() => validateGraph(value, snapshot), LensError, `invalid region case ${index + 1}`); });
});

test('ZIP CRC, unsupported formats, duplicate/alias paths, traversal and links fail closed', () => {
  const good = [{ name: 'SKILL.md', data: 'safe' }];
  const corrupt = zip(good); corrupt[30 + Buffer.byteLength('SKILL.md')] ^= 1; const corruptPath = path.join(work, 'crc.zip'); fs.writeFileSync(corruptPath, corrupt); assert.throws(() => snapshotSkill(corruptPath), /CRC/);
  for (const [name, extra, expected] of [
    ['traversal.zip', { name: '../oops', data: '' }, /非法包路径/],
    ['duplicate.zip', { name: 'SKILL.md', data: '' }, /重复/],
    ['alias.zip', { name: 'skill.md', data: '' }, /大小写冲突/],
    ['outside.zip', { name: 'other.txt', data: '' }, /根目录之外/],
    ['encrypted.zip', { name: 'encrypted', flags: 0x801 }, /加密/],
    ['link.zip', { name: 'link', attributes: (0xa1ff << 16) >>> 0 }, /链接/],
  ]) {
    const entries = name === 'outside.zip' ? [{ name: 'root/SKILL.md' }, extra] : [...good, extra];
    assert.throws(() => snapshotSkill(archive(name, entries)), expected);
  }
  assert.throws(() => snapshotSkill(archive('unicode-casefold.zip', [...good, { name: 'Straße.txt' }, { name: 'STRASSE.txt' }])), /大小写冲突/);
  const distinct = snapshotSkill(archive('unicode14-distinct.zip', [...good, ...['\u1c89', '\u1c8a', '\ua7cb', '\u0264', '\ua7cc', '\ua7cd', '\ua7da', '\ua7db', '\ua7dc', '\u019b', '\u{10d50}', '\u{10d70}'].map(name => ({ name: `${name}.txt` }))]));
  assert.equal(distinct.files.length, 13);
  const cp437 = snapshotSkill(archive('cp437.zip', [...good, { name: Buffer.from([0x82, 0x2e, 0x74, 0x78, 0x74]), flags: 0, data: 'cp437' }])); assert(cp437.files.some(file => file.path === 'é.txt'));
  for (const name of ['a\\b', '/absolute', 'a/./b', 'a//b', 'CON.txt', 'a:ads', 'trail.']) assert.throws(() => safeName(name), LensError);
});

test('ZIP streaming data descriptors with and without signatures are accepted', () => {
  for (const descriptor of ['signed', 'unsigned']) {
    const snapshot = snapshotSkill(archive(`descriptor-${descriptor}.zip`, [{ name: 'SKILL.md', data: 'streamed\n', method: 8, descriptor }]));
    assert.equal(snapshot.files[0].text, 'streamed\n');
  }
});

test('manual evidence stays read-only and validates provenance hashes', () => {
  const directory = source('manual', 'candidate\n'); fs.mkdirSync(path.join(directory, 'references'));
  const original = Buffer.from([1, 2, 255]), readable = Buffer.from('manual text\n');
  fs.writeFileSync(path.join(directory, 'references/manual-original.pdf'), original); fs.writeFileSync(path.join(directory, 'references/manual-readable.md'), readable);
  const provenance = { schema_version: 1, source_kind: 'manual', sources: [{ role: 'readable', file: 'references/manual-readable.md', sha256: hash(readable) }, { role: 'original', file: 'references/manual-original.pdf', sha256: hash(original) }], readonly_files: ['provenance.json', 'references/manual-readable.md', 'references/manual-original.pdf'] };
  fs.writeFileSync(path.join(directory, 'provenance.json'), JSON.stringify(provenance)); const snapshot = snapshotSkill(directory); assert.equal(snapshot.source_kind, 'manual');
  const input = graph(snapshot); input.nodes[0].evidence_refs = [{ file: 'references/manual-readable.md', start_line: 1, end_line: 1 }]; const [normalized] = validateGraph(input, snapshot); assert.equal(normalized.nodes[0].evidence_spans[0].text, 'manual text\n');
  assert.throws(() => validateGraph(graph(snapshot, [{ file: 'references/manual-readable.md', start_line: 1, end_line: 1 }]), snapshot), /只读/);
  fs.appendFileSync(path.join(directory, 'references/manual-readable.md'), 'tamper'); assert.throws(() => snapshotSkill(directory), /哈希不符/);
});

test('HTML renders entire template, escapes embedded payload, refuses original and existing outputs', () => {
  const directory = source('render', 'line\n'), snapshot = snapshotSkill(directory), input = graph(snapshot);
  input.title = '</script><script>bad()</script> & \u2028';
  const output = path.join(work, 'render.html'), snapshotOutput = path.join(work, 'render.json'), graphPath = path.join(work, 'graph.json'); fs.writeFileSync(graphPath, '\uFEFF' + JSON.stringify(input));
  const result = buildLens({ skill: directory, graph: graphPath, output, snapshot: snapshotOutput });
  assert.equal(result.ok, true); assert.equal(result.outputs.length, 2); const html = fs.readFileSync(output, 'utf8');
  assert(html.includes('id="lens-data"')); assert(html.includes('id="savePage"')); assert(html.includes('"version":"0.8.2"')); assert(!html.includes('</script><script>bad()')); assert(html.includes('\\u003c/script\\u003e'));
  assert.throws(() => buildLens({ skill: directory, snapshot: path.join(directory, 'generated.json') }), /输入 Skill 之外/);
  assert.throws(() => buildLens({ skill: directory, snapshot: snapshotOutput }), /已存在/);
  assert.throws(() => buildLens({ skill: directory, graph: graphPath, output: path.join(work, 'same'), snapshot: path.join(work, 'same') }), /同一路径/);
  assert(!fs.existsSync(path.join(work, 'same')));
});

test('manifest-verified managed views are stripped, original remains a leaf, staleness is recorded', () => {
  const directory = source('managed', 'core\n'), before = snapshotSkill(directory), input = graph(before);
  const originPath = path.join(work, 'origin.html'); buildLens({ skill: directory, graph: input, output: originPath }); const origin = fs.readFileSync(originPath);
  const html = origin.toString('utf8'), expression = /(<script\b[^>]*\bid="lens-data"[^>]*>)(.*?)(<\/script>)/s, match = html.match(expression); assert(match);
  const data = JSON.parse(match[2]); data.portability = { managed: true, origin_base64: origin.toString('base64'), origin_sha256: hash(origin), manifest: null };
  const current = Buffer.from(html.replace(expression, (_, start, payload, end) => start + JSON.stringify(data) + end));
  const graphBytes = Buffer.from(JSON.stringify(data.graph));
  const entries = [{ path: 'assets/skill-lens/index.html', role: 'current', data: current }, { path: 'assets/skill-lens/origin.html', role: 'origin', data: origin }, { path: 'assets/skill-lens/graph.json', role: 'graph', data: graphBytes }];
  fs.mkdirSync(path.join(directory, 'assets/skill-lens'), { recursive: true });
  for (const entry of entries) fs.writeFileSync(path.join(directory, entry.path), entry.data);
  const manifest = { schema_version: 1, generated_by: 'skill-lens', navigation_id: 'skill-lens-view-links-v1', retained_directories: [], current_source_fingerprint: before.source_fingerprint, files: entries.map(({ path, role, data }) => ({ path, role, bytes: data.length, sha256: hash(data) })) };
  fs.writeFileSync(path.join(directory, 'assets/skill-lens/manifest.json'), JSON.stringify(manifest));
  fs.appendFileSync(path.join(directory, 'SKILL.md'), '\n\n<!-- skill-lens:view-links:v1 -->\n## Skill 图解\n\n- [查看当前 Skill 图解](assets/skill-lens/index.html)\n- [查看首次原图](assets/skill-lens/origin.html)\n\n<!-- /skill-lens:view-links:v1 -->\n');
  const after = snapshotSkill(directory); assert.equal(after.source_fingerprint, before.source_fingerprint); assert.equal(after.files.length, 1); assert.equal(after.files[0].text, 'core\n'); assert.equal(after.portability.managed, true); assert.equal(after.portability.stale, false); assert(after.files[0].source_sha256); assert(!ownPortable(agentSnapshot(after).portability));
  fs.writeFileSync(path.join(directory, 'new.md'), 'new'); assert.equal(snapshotSkill(directory).portability.stale, true);
  fs.appendFileSync(path.join(directory, 'assets/skill-lens/origin.html'), 'changed'); assert.throws(() => snapshotSkill(directory), /SHA-256/);
});
function ownPortable(value) { return Object.hasOwn(value, 'origin_base64'); }

test('symbolic links and junction ancestors are refused', t => {
  const target = source('link-target', 'x\n'), link = path.join(work, 'linked');
  try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { t.skip(`symlink unavailable: ${error.code}`); return; }
  assert.throws(() => snapshotSkill(link), /符号链接或重解析点/); assert.throws(() => checkAncestors(path.join(link, 'missing.json')), /符号链接或重解析点/);
});
