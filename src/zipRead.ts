// 最小限の zip リーダー（読み取り専用・メモリ上だけ）。kintone のアプリテンプレート zip から、名前を指定した 1 ファイルの本文を取り出す。
// - 中央ディレクトリ（終端 → 各エントリ）だけを信頼する。kintone の zip はデータ記述子（フラグ bit 3）を使い、
//   ローカルヘッダーのサイズが 0 になるため。
// - 対応は無圧縮（0）と deflate（8）。暗号化・zip64・分割 zip は拒否する。
// - ディスクへは展開しない。エントリ名はパスとして使わず、名前の完全一致で探すだけ（パス・トラバーサルの余地を作らない）。
// - 展開サイズ・エントリ数に上限を置く（zip 爆弾対策）。

import zlib from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;

// CRC-32（zip の検査用）。zlib.crc32 は Node 22.2 以降にしか無いため、engines（>=22）に合わせて自前で持つ。
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export const ZIP_MAX_ENTRIES = 1000;
export const ZIP_MAX_ENTRY_BYTES = 16 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

// 中央ディレクトリのエントリを列挙する。
export function listZipEntries(zip: Buffer): ZipEntry[] {
  if (zip.length < EOCD_MIN_SIZE) throw new Error("zip ファイルではありません（小さすぎます）。");
  let eocd = -1;
  const lowest = Math.max(0, zip.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
  for (let i = zip.length - EOCD_MIN_SIZE; i >= lowest; i -= 1) {
    if (zip.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip の終端（End of central directory）が見つかりません。zip ファイルではないか、壊れています。");

  // 分割 zip（複数ディスク）は、ディスク番号と、このディスクのエントリ数で見分けて拒否する。
  if (zip.readUInt16LE(eocd + 4) !== 0 || zip.readUInt16LE(eocd + 6) !== 0 || zip.readUInt16LE(eocd + 8) !== zip.readUInt16LE(eocd + 10)) {
    throw new Error("分割された zip には対応していません。");
  }
  const count = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("zip64 の zip には対応していません。");
  }
  if (count > ZIP_MAX_ENTRIES) throw new Error(`zip のエントリ数が多すぎます（${count} 件。上限 ${ZIP_MAX_ENTRIES} 件）。`);

  const entries: ZipEntry[] = [];
  let pos = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (pos + 46 > zip.length || zip.readUInt32LE(pos) !== CENTRAL_SIGNATURE) {
      throw new Error("zip の中央ディレクトリが壊れています。");
    }
    const flags = zip.readUInt16LE(pos + 8);
    const nameLength = zip.readUInt16LE(pos + 28);
    const extraLength = zip.readUInt16LE(pos + 30);
    const commentLength = zip.readUInt16LE(pos + 32);
    if (pos + 46 + nameLength > zip.length) throw new Error("zip の中央ディレクトリが壊れています。");
    entries.push({
      // フラグ bit 11 = ファイル名が UTF-8。無ければ ASCII 以外は正確に復元できないので latin1 で読む（このツールは ASCII の名前しか探さない）。
      name: zip.toString(flags & 0x800 ? "utf8" : "latin1", pos + 46, pos + 46 + nameLength),
      method: zip.readUInt16LE(pos + 10),
      flags,
      crc32: zip.readUInt32LE(pos + 16),
      compressedSize: zip.readUInt32LE(pos + 20),
      size: zip.readUInt32LE(pos + 24),
      localOffset: zip.readUInt32LE(pos + 42)
    });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// エントリ 1 件の本文を取り出す（CRC 検査つき）。
export function readZipEntry(zip: Buffer, entry: ZipEntry, maxEntryBytes = ZIP_MAX_ENTRY_BYTES): Buffer {
  if (entry.flags & 1) throw new Error(`zip のエントリ ${entry.name} は暗号化されています。`);
  if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff) throw new Error("zip64 の zip には対応していません。");
  if (entry.size > maxEntryBytes) {
    throw new Error(`zip のエントリ ${entry.name} が大きすぎます（${entry.size} バイト。上限 ${maxEntryBytes} バイト）。`);
  }
  const header = entry.localOffset;
  if (header + 30 > zip.length || zip.readUInt32LE(header) !== LOCAL_SIGNATURE) {
    throw new Error(`zip のエントリ ${entry.name} のヘッダーが壊れています。`);
  }
  const start = header + 30 + zip.readUInt16LE(header + 26) + zip.readUInt16LE(header + 28);
  const end = start + entry.compressedSize;
  if (end > zip.length) throw new Error(`zip のエントリ ${entry.name} のデータが途中で切れています。`);
  const raw = zip.subarray(start, end);

  let data: Buffer;
  if (entry.method === 0) {
    data = Buffer.from(raw);
  } else if (entry.method === 8) {
    try {
      data = zlib.inflateRawSync(raw, { maxOutputLength: maxEntryBytes });
    } catch (error) {
      throw new Error(`zip のエントリ ${entry.name} を展開できません: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    throw new Error(`zip のエントリ ${entry.name} は未対応の圧縮方式です（method=${entry.method}）。`);
  }
  if (data.length !== entry.size) throw new Error(`zip のエントリ ${entry.name} のサイズが一致しません（壊れています）。`);
  if (crc32(data) !== entry.crc32) throw new Error(`zip のエントリ ${entry.name} の CRC が一致しません（壊れています）。`);
  return data;
}

// 名前が一致するエントリの本文を返す。無ければ undefined。
// 区切りの `\` は `/` として比べる（Windows PowerShell 5.1 の Compress-Archive は `\` で書く）。名前はパスとして使わない。
export function readZipFile(zip: Buffer, name: string): Buffer | undefined {
  const entry = listZipEntries(zip).find((item) => item.name.replaceAll("\\", "/") === name);
  return entry ? readZipEntry(zip, entry) : undefined;
}
