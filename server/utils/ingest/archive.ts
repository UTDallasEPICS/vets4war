// An .xlsx file is a zip archive. Before any worksheet is parsed, this reads the
// archive's central directory by hand (no dependency) and refuses what would be
// expensive or ambiguous to read: too many parts, too much once unpacked, too many
// sheets, zip64, entries whose local header disagrees with the directory, and sheets
// that share one worksheet. It also names every sheet, because the streaming reader
// only knows a worksheet by its part name (xl/worksheets/sheet3.xml).
import { open, type FileHandle } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_SHEETS,
  MAX_UNPACKED_BYTES,
  MAX_WORKBOOK_PART_BYTES,
} from './limits'

export type ArchiveErrorCode = 'not_a_workbook' | 'too_large_unpacked' | 'too_many_sheets'

export class ArchiveError extends Error {
  code: ArchiveErrorCode
  constructor(code: ArchiveErrorCode, message: string) {
    super(message)
    this.name = 'ArchiveError'
    this.code = code
  }
}

export interface SheetPart {
  name: string
  // The worksheet's part in the archive; null for a chart sheet or another kind of
  // sheet that cannot hold rows.
  part: string | null
}

export interface ArchiveInfo {
  entries: number
  unpackedBytes: number
  sheets: SheetPart[] // in the workbook's own order
}

export const NOT_A_WORKBOOK =
  'This file is not an Excel workbook (.xlsx). Export the call records as .xlsx and try again.'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const EOCD_SIZE = 22
const CENTRAL_SIZE = 46
const LOCAL_SIZE = 30
const ZIP64_LOCATOR_SIZE = 20
const MAX_COMMENT = 0xffff
const U16_MAX = 0xffff
const U32_MAX = 0xffffffff
const FLAG_DATA_DESCRIPTOR = 0x08
const STORED = 0
const DEFLATED = 8
// The streaming reader picks worksheets out of the archive by this name pattern only.
const WORKSHEET_PART = /^xl\/worksheets\/sheet\d+\.xml$/
const WORKBOOK = 'xl/workbook.xml'
const WORKBOOK_RELS = 'xl/_rels/workbook.xml.rels'

interface Entry {
  name: string
  method: number
  flags: number
  compressedSize: number
  size: number
  localOffset: number
}

function refuse(message = NOT_A_WORKBOOK): never {
  throw new ArchiveError('not_a_workbook', message)
}

async function readAt(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await file.read(buffer, 0, length, position)
  if (bytesRead !== length) refuse()
  return buffer
}

function findEndOfDirectory(tail: Buffer): number {
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== EOCD_SIGNATURE) continue
    if (i + EOCD_SIZE + tail.readUInt16LE(i + 20) === tail.length) return i
  }
  return refuse()
}

function readDirectory(directory: Buffer, count: number): Entry[] {
  const entries: Entry[] = []
  let p = 0
  for (let k = 0; k < count; k++) {
    if (p + CENTRAL_SIZE > directory.length || directory.readUInt32LE(p) !== CENTRAL_SIGNATURE) {
      refuse()
    }
    const nameLength = directory.readUInt16LE(p + 28)
    const extraLength = directory.readUInt16LE(p + 30)
    const commentLength = directory.readUInt16LE(p + 32)
    const entry: Entry = {
      flags: directory.readUInt16LE(p + 8),
      method: directory.readUInt16LE(p + 10),
      compressedSize: directory.readUInt32LE(p + 20),
      size: directory.readUInt32LE(p + 24),
      localOffset: directory.readUInt32LE(p + 42),
      name: '',
    }
    const end = p + CENTRAL_SIZE + nameLength
    if (end > directory.length) refuse()
    entry.name = directory.toString('utf8', p + CENTRAL_SIZE, end)
    // A field at its maximum means the real value is in a zip64 extra field.
    if (
      entry.compressedSize === U32_MAX ||
      entry.size === U32_MAX ||
      entry.localOffset === U32_MAX
    ) {
      refuse()
    }
    entries.push(entry)
    p = end + extraLength + commentLength
  }
  return entries
}

// The streaming reader trusts local headers, not the directory: they must agree, or the
// limits checked here would not be the limits that apply.
async function checkLocalHeader(file: FileHandle, entry: Entry, directoryOffset: number) {
  const header = await readAt(file, entry.localOffset, LOCAL_SIZE)
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) refuse()
  const nameLength = header.readUInt16LE(26)
  const extraLength = header.readUInt16LE(28)
  const name = (await readAt(file, entry.localOffset + LOCAL_SIZE, nameLength)).toString('utf8')
  if (name !== entry.name || header.readUInt16LE(8) !== entry.method) refuse()
  if (!(header.readUInt16LE(6) & FLAG_DATA_DESCRIPTOR)) {
    if (header.readUInt32LE(18) !== entry.compressedSize || header.readUInt32LE(22) !== entry.size)
      refuse()
  }
  const dataStart = entry.localOffset + LOCAL_SIZE + nameLength + extraLength
  if (dataStart + entry.compressedSize > directoryOffset) refuse()
  return dataStart
}

async function readPart(file: FileHandle, entry: Entry, directoryOffset: number): Promise<string> {
  if (entry.size > MAX_WORKBOOK_PART_BYTES) refuse()
  const dataStart = await checkLocalHeader(file, entry, directoryOffset)
  const raw = await readAt(file, dataStart, entry.compressedSize)
  let data: Buffer
  if (entry.method === STORED) data = raw
  else if (entry.method === DEFLATED) {
    try {
      data = inflateRawSync(raw, { maxOutputLength: MAX_WORKBOOK_PART_BYTES })
    } catch {
      return refuse()
    }
  } else return refuse()
  if (data.length !== entry.size) refuse()
  return data.toString('utf8')
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, ref: string) => {
    if (ref.startsWith('#x')) return String.fromCodePoint(parseInt(ref.slice(2), 16))
    if (ref.startsWith('#')) return String.fromCodePoint(parseInt(ref.slice(1), 10))
    return ENTITIES[ref] ?? ''
  })
}

function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    found.set(match[1]!, decodeXml(match[2] ?? match[3] ?? ''))
  }
  return found
}

function relationshipId(attrs: Map<string, string>): string | undefined {
  for (const [key, value] of attrs) if (key.endsWith(':id')) return value
  return undefined
}

// Relationship targets are relative to xl/ unless they start with '/'.
function resolveTarget(target: string): string {
  const segments = (target.startsWith('/') ? target.slice(1) : `xl/${target}`).split('/')
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === '..') resolved.pop()
    else if (segment !== '.' && segment !== '') resolved.push(segment)
  }
  return resolved.join('/')
}

function sheetsOf(workbookXml: string, relsXml: string, partNames: Set<string>): SheetPart[] {
  const relationships = new Map<string, { type: string; target: string; external: boolean }>()
  for (const match of relsXml.matchAll(/<(?:[\w.-]+:)?Relationship\b([^>]*)>/g)) {
    const attrs = attributes(match[1]!)
    const id = attrs.get('Id')
    if (!id) continue
    relationships.set(id, {
      type: attrs.get('Type') ?? '',
      target: attrs.get('Target') ?? '',
      external: attrs.get('TargetMode') === 'External',
    })
  }
  const sheets: SheetPart[] = []
  for (const match of workbookXml.matchAll(/<(?:[\w.-]+:)?sheet\b([^>]*)>/g)) {
    const attrs = attributes(match[1]!)
    const name = attrs.get('name')
    const id = relationshipId(attrs)
    const relationship = id === undefined ? undefined : relationships.get(id)
    if (name === undefined || !relationship || relationship.external) refuse()
    if (!relationship.type.endsWith('/worksheet')) {
      sheets.push({ name, part: null })
      continue
    }
    const part = resolveTarget(relationship.target)
    if (!partNames.has(part) || !WORKSHEET_PART.test(part)) {
      refuse(
        'The sheets of this workbook are stored in a way this reader does not recognise. ' +
          'Open it in Excel, save it as .xlsx and try again.'
      )
    }
    sheets.push({ name, part })
  }
  if (sheets.length === 0) refuse()
  return sheets
}

export async function inspectArchive(path: string): Promise<ArchiveInfo> {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    if (size < EOCD_SIZE) refuse()
    const tailLength = Math.min(size, EOCD_SIZE + MAX_COMMENT)
    const tailStart = size - tailLength
    const tail = await readAt(file, tailStart, tailLength)
    const at = findEndOfDirectory(tail)
    const disk = tail.readUInt16LE(at + 4)
    const directoryDisk = tail.readUInt16LE(at + 6)
    const entriesOnDisk = tail.readUInt16LE(at + 8)
    const count = tail.readUInt16LE(at + 10)
    const directorySize = tail.readUInt32LE(at + 12)
    const directoryOffset = tail.readUInt32LE(at + 16)
    const zip64 =
      count === U16_MAX ||
      directorySize === U32_MAX ||
      directoryOffset === U32_MAX ||
      (at >= ZIP64_LOCATOR_SIZE &&
        tail.readUInt32LE(at - ZIP64_LOCATOR_SIZE) === ZIP64_LOCATOR_SIGNATURE)
    if (zip64 || disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== count) refuse()
    if (count > MAX_ARCHIVE_ENTRIES) {
      throw new ArchiveError(
        'too_large_unpacked',
        `The workbook holds ${count.toLocaleString('en-US')} parts; the limit is ` +
          `${MAX_ARCHIVE_ENTRIES.toLocaleString('en-US')}. Export the call records again as a plain .xlsx.`
      )
    }
    if (directoryOffset + directorySize > tailStart + at) refuse()

    const entries = readDirectory(await readAt(file, directoryOffset, directorySize), count)
    const unpackedBytes = entries.reduce((sum, entry) => sum + entry.size, 0)
    if (unpackedBytes > MAX_UNPACKED_BYTES) {
      const mb = (bytes: number) => Math.ceil(bytes / (1024 * 1024))
      throw new ArchiveError(
        'too_large_unpacked',
        `The workbook unpacks to ${mb(unpackedBytes)} MB; the limit is ${mb(MAX_UNPACKED_BYTES)} MB. ` +
          'Split it into smaller files.'
      )
    }
    const byName = new Map<string, Entry>()
    for (const entry of entries) {
      if (byName.has(entry.name)) refuse()
      byName.set(entry.name, entry)
    }
    for (const entry of entries) await checkLocalHeader(file, entry, directoryOffset)

    const workbook = byName.get(WORKBOOK)
    const rels = byName.get(WORKBOOK_RELS)
    if (!workbook || !rels) refuse()
    const sheets = sheetsOf(
      await readPart(file, workbook, directoryOffset),
      await readPart(file, rels, directoryOffset),
      new Set(byName.keys())
    )
    if (sheets.length > MAX_SHEETS) {
      throw new ArchiveError(
        'too_many_sheets',
        `The workbook has ${sheets.length} sheets; the limit is ${MAX_SHEETS}. ` +
          'Remove the sheets that do not hold call records, or split the file.'
      )
    }
    const parts = sheets.flatMap((sheet) => (sheet.part ? [sheet.part] : []))
    if (new Set(parts).size !== parts.length) {
      refuse('Two or more sheets of this workbook share one worksheet. Export the file again.')
    }
    return { entries: entries.length, unpackedBytes, sheets }
  } finally {
    await file.close()
  }
}
