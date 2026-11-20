// A minimal zip writer for crafting archives the archive check must refuse. Entries are
// stored (no compression). `directory` overrides what the central directory claims, and
// `local` what the local header claims, so a test can make them lie about sizes or counts.
import { posix } from 'node:path'
import { crc32 } from 'node:zlib'

export interface ZipEntry {
  name: string
  data: Buffer | string
  directory?: { size?: number; compressedSize?: number }
  local?: { compressedSize?: number; size?: number }
}

export function buildZip(entries: ZipEntry[], options: { countOverride?: number } = {}): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const name = Buffer.from(entry.name)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.local?.compressedSize ?? data.length, 18)
    local.writeUInt32LE(entry.local?.size ?? data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(entry.directory?.compressedSize ?? data.length, 20)
    central.writeUInt32LE(entry.directory?.size ?? data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  const count = options.countOverride ?? entries.length
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const SHEET_XML =
  '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>'

// The parts of a workbook, by hand: `sheets` maps each sheet name to the worksheet
// target its relationship points at.
export function workbookEntries(sheets: { name: string; target: string }[]): ZipEntry[] {
  const workbook =
    '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets
      .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('') +
    '</sheets></workbook>'
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets
      .map(
        (s, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${s.target}"/>`
      )
      .join('') +
    '</Relationships>'
  const parts = [...new Set(sheets.map((s) => s.target))].map((target) => ({
    name: posix.normalize(target.startsWith('/') ? target.slice(1) : `xl/${target}`),
    data: SHEET_XML,
  }))
  return [
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    ...parts,
  ]
}
