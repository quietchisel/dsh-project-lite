/**
 * core/zip.mjs — 最小 ZIP 写入器（stored / 无压缩）。
 *
 * 为什么自己写：本机没有装 zip 库，也不想给 S0 引依赖。ZIP 的 stored 格式足够简单：
 * 本地文件头 + 数据 + 中央目录 + EOCD，CRC32 自算。
 * 产物会被 Python 的 zipfile 独立校验（testzip + 逐条 SHA256），所以"自己写的 ZIP 自己能读"不构成证据。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

export function crc32(buf) {
  let c = 0 ^ -1
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ TABLE[(c ^ buf[i]) & 0xff]
  return (c ^ -1) >>> 0
}

function dosTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f)
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f)
  return { time, date }
}

export class ZipWriter {
  constructor() { this.entries = []; this.parts = []; this.offset = 0 }

  add(name, data, when = new Date()) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    const nameBuf = Buffer.from(name.split(sep).join('/'), 'utf8')
    const { time, date } = dosTime(when)
    const crc = crc32(buf)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)        // version needed
    local.writeUInt16LE(0x0800, 6)    // UTF-8 name flag
    local.writeUInt16LE(0, 8)         // stored
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(buf.length, 18)
    local.writeUInt32LE(buf.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    this.parts.push(local, nameBuf, buf)
    this.entries.push({ name: nameBuf, crc, size: buf.length, offset: this.offset, time, date })
    this.offset += 30 + nameBuf.length + buf.length
    return this
  }

  finalize() {
    const cdParts = []
    let cdSize = 0
    for (const e of this.entries) {
      const h = Buffer.alloc(46)
      h.writeUInt32LE(0x02014b50, 0)
      h.writeUInt16LE(20, 4)
      h.writeUInt16LE(20, 6)
      h.writeUInt16LE(0x0800, 8)
      h.writeUInt16LE(0, 10)
      h.writeUInt16LE(e.time, 12)
      h.writeUInt16LE(e.date, 14)
      h.writeUInt32LE(e.crc, 16)
      h.writeUInt32LE(e.size, 20)
      h.writeUInt32LE(e.size, 24)
      h.writeUInt16LE(e.name.length, 28)
      h.writeUInt16LE(0, 30); h.writeUInt16LE(0, 32); h.writeUInt16LE(0, 34)
      h.writeUInt16LE(0, 36); h.writeUInt32LE(0, 38)
      h.writeUInt32LE(e.offset, 42)
      cdParts.push(h, e.name)
      cdSize += 46 + e.name.length
    }
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(this.entries.length, 8)
    eocd.writeUInt16LE(this.entries.length, 10)
    eocd.writeUInt32LE(cdSize, 12)
    eocd.writeUInt32LE(this.offset, 16)
    eocd.writeUInt16LE(0, 20)
    return Buffer.concat([...this.parts, ...cdParts, eocd])
  }
}

/** 把一个目录整棵打进 zip（相对路径用 / 分隔，UTF-8 名带标记）。 */
export async function zipDirectory(rootDir) {
  const zw = new ZipWriter()
  const files = []
  async function walk(dir) {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) await walk(p)
      else files.push(p)
    }
  }
  await walk(rootDir)
  files.sort()
  for (const f of files) {
    zw.add(relative(rootDir, f), await readFile(f))
  }
  return { buffer: zw.finalize(), files: files.map(f => relative(rootDir, f)), count: files.length }
}
