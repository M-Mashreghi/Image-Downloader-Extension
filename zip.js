// Minimal ZIP writer (STORE method, no compression - images are already compressed).
// Supports ZIP64 so very large collections still work.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

class ZipWriter {
  constructor() { this.parts = []; this.central = []; this.offset = 0; this.count = 0; }

  add(name, data) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const size = data.length;
    const { time, date } = dosDateTime(new Date());
    const needZip64 = this.offset >= 0xffffffff;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true);      // STORE
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    this.parts.push(local.buffer, nameBytes, data);

    this.central.push({ nameBytes, crc, size, time, date, offset: this.offset, needZip64 });
    this.offset += 30 + nameBytes.length + size;
    this.count++;
  }

  finish() {
    const cdStart = this.offset;
    let cdSize = 0;
    for (const e of this.central) {
      const extra = e.needZip64 ? 12 : 0;
      const h = new DataView(new ArrayBuffer(46 + extra));
      h.setUint32(0, 0x02014b50, true);
      h.setUint16(4, e.needZip64 ? 45 : 20, true);
      h.setUint16(6, e.needZip64 ? 45 : 20, true);
      h.setUint16(8, 0x0800, true);
      h.setUint16(10, 0, true);
      h.setUint16(12, e.time, true);
      h.setUint16(14, e.date, true);
      h.setUint32(16, e.crc, true);
      h.setUint32(20, e.size, true);
      h.setUint32(24, e.size, true);
      h.setUint16(28, e.nameBytes.length, true);
      h.setUint16(30, extra, true);
      h.setUint32(42, e.needZip64 ? 0xffffffff : e.offset, true);
      if (e.needZip64) {
        h.setUint16(46, 0x0001, true);
        h.setUint16(48, 8, true);
        h.setBigUint64(50, BigInt(e.offset), true);
      }
      // ZIP64 extra goes after the name, so split the header
      const fixed = h.buffer.slice(0, 46);
      this.parts.push(fixed, e.nameBytes);
      if (extra) this.parts.push(h.buffer.slice(46));
      cdSize += 46 + e.nameBytes.length + extra;
    }
    const zip64 = this.count >= 0xffff || cdStart >= 0xffffffff || cdSize >= 0xffffffff;
    if (zip64) {
      const z = new DataView(new ArrayBuffer(56 + 20));
      z.setUint32(0, 0x06064b50, true);
      z.setBigUint64(4, 44n, true);
      z.setUint16(12, 45, true);
      z.setUint16(14, 45, true);
      z.setBigUint64(24, BigInt(this.count), true);
      z.setBigUint64(32, BigInt(this.count), true);
      z.setBigUint64(40, BigInt(cdSize), true);
      z.setBigUint64(48, BigInt(cdStart), true);
      z.setUint32(56, 0x07064b50, true);
      z.setBigUint64(64, BigInt(cdStart + cdSize), true);
      z.setUint32(72, 1, true);
      this.parts.push(z.buffer);
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, Math.min(this.count, 0xffff), true);
    end.setUint16(10, Math.min(this.count, 0xffff), true);
    end.setUint32(12, Math.min(cdSize, 0xffffffff), true);
    end.setUint32(16, Math.min(cdStart, 0xffffffff), true);
    this.parts.push(end.buffer);
    return new Blob(this.parts, { type: "application/zip" });
  }
}
