/** Bounded, read-only ZIP reader. No input code is executed. */
import { inflateRawSync } from 'node:zlib';

export class ZipError extends Error { constructor(message) { super(message); this.name = 'ZipError'; } }
const fail = message => { throw new ZipError(message); };
const CP437 = Array.from('ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ');
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let x = i; for (let bit = 0; bit < 8; bit++) x = x & 1 ? (x >>> 1) ^ 0xedb88320 : x >>> 1; crcTable[i] = x >>> 0; }
export function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function nameOf(bytes, utf8) {
  if (utf8) { try { return UTF8.decode(bytes); } catch { fail('ZIP UTF-8 文件名无效'); } }
  return Array.from(bytes, byte => byte < 128 ? String.fromCharCode(byte) : CP437[byte - 128]).join('');
}
function bounded(buffer, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) fail(`ZIP ${label} 越界或已截断`);
  return buffer.subarray(offset, offset + length);
}
function extras(bytes) {
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) fail('ZIP 扩展字段已截断');
    const id = bytes.readUInt16LE(offset), size = bytes.readUInt16LE(offset + 2);
    if (offset + 4 + size > bytes.length) fail('ZIP 扩展字段已截断');
    if (id === 0x0001) fail('不支持 ZIP64；请提供普通 stored/deflate ZIP');
    offset += 4 + size;
  }
}

/** Returns central-directory entries with verified, uncompressed bytes. */
export function readZip(buffer, { safeName, fileLimit, maxEntries = 2048, maxTotalBytes = 168 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buffer)) fail('ZIP 输入须为 Buffer');
  let end = -1;
  for (let at = buffer.length - 22, minimum = Math.max(0, buffer.length - 22 - 65535); at >= minimum; at--) {
    if (buffer.readUInt32LE(at) === 0x06054b50 && at + 22 + buffer.readUInt16LE(at + 20) === buffer.length) { end = at; break; }
  }
  if (end < 0) fail('ZIP 结束记录缺失、已截断或格式不支持');
  const disk = buffer.readUInt16LE(end + 4), centralDisk = buffer.readUInt16LE(end + 6);
  const diskCount = buffer.readUInt16LE(end + 8), count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12), centralOffset = buffer.readUInt32LE(end + 16);
  if (disk || centralDisk || diskCount !== count) fail('不支持分卷 ZIP');
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('不支持 ZIP64；请提供普通 stored/deflate ZIP');
  if (count > maxEntries) fail(`ZIP 条目超过 ${maxEntries} 个，请移除无关文件后重试`);
  bounded(buffer, centralOffset, centralSize, '中央目录');
  if (centralOffset + centralSize !== end) fail('ZIP 中央目录范围不一致或含不支持的附加记录');
  const entries = [], spans = [];
  let at = centralOffset, total = 0;
  for (let i = 0; i < count; i++) {
    const header = bounded(buffer, at, 46, '中央目录条目');
    if (header.readUInt32LE(0) !== 0x02014b50) fail('ZIP 中央目录条目无效');
    const created = header.readUInt16LE(4), needed = header.readUInt16LE(6), flags = header.readUInt16LE(8), method = header.readUInt16LE(10);
    const crc = header.readUInt32LE(16), compressedSize = header.readUInt32LE(20), size = header.readUInt32LE(24);
    const nameSize = header.readUInt16LE(28), extraSize = header.readUInt16LE(30), commentSize = header.readUInt16LE(32);
    const diskStart = header.readUInt16LE(34), attributes = header.readUInt32LE(38), localOffset = header.readUInt32LE(42);
    if ([compressedSize, size, localOffset].includes(0xffffffff) || diskStart === 0xffff) fail('不支持 ZIP64');
    if (diskStart) fail('不支持分卷 ZIP');
    if (flags & (1 | 0x40 | 0x2000)) fail('不支持加密 ZIP');
    if (flags & ~0x080e) fail('ZIP 含不支持的标志位');
    if (method !== 0 && method !== 8) fail(`不支持 ZIP 压缩方法 ${method}；仅支持 stored/deflate`);
    if (needed > 20) fail('不支持此 ZIP 格式版本；仅支持普通 stored/deflate ZIP');
    const variable = bounded(buffer, at + 46, nameSize + extraSize + commentSize, '中央目录名称');
    const rawName = variable.subarray(0, nameSize), decoded = nameOf(rawName, Boolean(flags & 0x800));
    const directory = decoded.endsWith('/'), name = safeName(directory ? decoded.slice(0, -1) : decoded);
    extras(variable.subarray(nameSize, nameSize + extraSize));
    const mode = attributes >>> 16, kind = mode & 0xf000;
    if (kind === 0xa000 || ((created >>> 8) === 0 && (attributes & 0x400))) fail(`ZIP 包含链接或重解析点: ${name}`);
    if (kind && kind !== 0x8000 && kind !== 0x4000) fail(`ZIP 仅支持常规文件及目录: ${name}`);
    if (kind === 0x4000 && !directory) fail(`ZIP 目录类型与路径不一致: ${name}`);
    if (size > fileLimit(name)) fail(`单文件超过允许尺寸: ${name}`);
    total += size;
    if (total > maxTotalBytes) fail('ZIP 展开总尺寸超过限制');
    if (directory && size !== 0) fail(`ZIP 目录含有文件载荷: ${name}`);
    const local = bounded(buffer, localOffset, 30, '本地文件头');
    if (local.readUInt32LE(0) !== 0x04034b50) fail(`ZIP 本地文件头无效: ${name}`);
    const localNameSize = local.readUInt16LE(26), localExtraSize = local.readUInt16LE(28);
    if (local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method) fail(`ZIP 本地与中央目录标志/方法不符: ${name}`);
    const localVariable = bounded(buffer, localOffset + 30, localNameSize + localExtraSize, '本地名称');
    if (!localVariable.subarray(0, localNameSize).equals(rawName)) fail(`ZIP 本地与中央目录名称不符: ${name}`);
    extras(localVariable.subarray(localNameSize));
    if (!(flags & 8) && (local.readUInt32LE(14) !== crc || local.readUInt32LE(18) !== compressedSize || local.readUInt32LE(22) !== size)) fail(`ZIP 本地与中央目录尺寸/CRC 不符: ${name}`);
    const start = localOffset + 30 + localNameSize + localExtraSize;
    if (start + compressedSize > centralOffset) fail(`ZIP 文件载荷超出数据区: ${name}`);
    const compressed = bounded(buffer, start, compressedSize, '压缩载荷');
    let data;
    try { data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: Math.max(1, Math.min(size + 1, fileLimit(name) + 1)), info: true }); }
    catch { fail(`ZIP deflate 载荷损坏或展开超限: ${name}`); }
    if (method === 8) {
      if (data.engine.bytesWritten !== compressedSize) fail(`ZIP deflate 载荷含未消费的数据: ${name}`);
      data = data.buffer;
    }
    if (data.length !== size || crc32(data) !== crc) fail(`ZIP 文件尺寸或 CRC-32 不符: ${name}`);
    let spanEnd = start + compressedSize;
    if (flags & 8) {
      // A signature is optional; a real CRC may itself equal 0x08074b50.
      const matches = descriptor => descriptor + 12 <= centralOffset && buffer.readUInt32LE(descriptor) === crc && buffer.readUInt32LE(descriptor + 4) === compressedSize && buffer.readUInt32LE(descriptor + 8) === size;
      if (spanEnd + 4 <= centralOffset && buffer.readUInt32LE(spanEnd) === 0x08074b50 && matches(spanEnd + 4)) spanEnd += 16;
      else if (matches(spanEnd)) spanEnd += 12;
      else fail(`ZIP 数据描述符无效: ${name}`);
    }
    spans.push([localOffset, spanEnd]);
    entries.push({ name, directory, data });
    at += 46 + nameSize + extraSize + commentSize;
  }
  if (at !== centralOffset + centralSize) fail('ZIP 中央目录计数或尺寸不符');
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) fail('ZIP 本地条目载荷重叠');
  return entries;
}
