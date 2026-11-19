// An .xlsx file is a zip archive. Before any worksheet is parsed, this reads the
// archive's central directory by hand (no dependency) and refuses what would be
// expensive or ambiguous to read: too many parts, too much once unpacked, too many
// sheets, zip64, entries whose local header disagrees with the directory, and sheets
// that share one worksheet. It also names every sheet and locates every part, so the
// parser can stream each part straight from the file (openPart) in a fixed order.
import { createReadStream } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { Readable, Transform, pipeline } from 'node:stream'
import { createInflateRaw, inflateRawSync } from 'node:zlib'
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

export interface PartLocation {
  method: number
  dataStart: number
  compressedSize: number
  size: number
}

export interface ArchiveInfo {
  entries: number
  unpackedBytes: number
  sheets: SheetPart[] // in the workbook's own order
  parts: Map<string, PartLocation>
  workbook: string
  workbookRels: string
  sharedStrings: string | null
  styles: string | null
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

// The local header must agree with the directory, or the limits checked against the
// directory would not be the limits that apply. Returns where the entry's data starts.
async function checkLocalHeader(file: FileHandle, entry: Entry, directoryOffset: number) {
  const header = await readAt(file, entry.localOffset, LOCAL_SIZE)
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) refuse()
  const nameLength = header.readUInt16LE(26)
  const extraLength = header.readUInt16LE(28)
  const name = (await readAt(file, entry.localOffset + LOCAL_SIZE, nameLength)).toString('utf8')
  if (name !== entry.name || header.readUInt16LE(8) !== entry.method) refuse()
  if (entry.method !== STORED && entry.method !== DEFLATED) refuse()
  if (!(header.readUInt16LE(6) & FLAG_DATA_DESCRIPTOR)) {
    if (header.readUInt32LE(18) !== entry.compressedSize || header.readUInt32LE(22) !== entry.size)
      refuse()
  }
  const dataStart = entry.localOffset + LOCAL_SIZE + nameLength + extraLength
  if (dataStart + entry.compressedSize > directoryOffset) refuse()
  return dataStart
}

async function readSmallPart(file: FileHandle, location: PartLocation): Promise<string> {
  if (location.size > MAX_WORKBOOK_PART_BYTES) refuse()
  const raw = await readAt(file, location.dataStart, location.compressedSize)
  let data = raw
  if (location.method === DEFLATED) {
    try {
      data = inflateRawSync(raw, { maxOutputLength: MAX_WORKBOOK_PART_BYTES })
    } catch {
      return refuse()
    }
  }
  if (data.length !== location.size) refuse()
  return data.toString('utf8')
}

// One part as a stream of UTF-8 text, read straight from the file. It fails when the
// part inflates to more (or less) than the directory declared, so the unpacked-size
// limit holds whatever the compressed data says.
export function openPart(path: string, location: PartLocation): Readable {
  if (location.compressedSize === 0) {
    if (location.size === 0) return Readable.from([])
    return new Readable({
      read() {
        this.destroy(new ArchiveError('not_a_workbook', NOT_A_WORKBOOK))
      },
    })
  }
  const raw = createReadStream(path, {
    start: location.dataStart,
    end: location.dataStart + location.compressedSize - 1,
  })
  let seen = 0
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length
      done(seen > location.size ? new ArchiveError('not_a_workbook', NOT_A_WORKBOOK) : null, chunk)
    },
    flush(done) {
      done(seen === location.size ? null : new ArchiveError('not_a_workbook', NOT_A_WORKBOOK))
    },
  })
  const stages = location.method === DEFLATED ? [raw, createInflateRaw(), counted] : [raw, counted]
  // pipeline destroys every stage on an error and hands it to the last one, so the
  // consumer's for-await sees it.
  pipeline(stages as [Readable, ...Transform[]], () => {})
  counted.setEncoding('utf8')
  return counted
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

interface Relationship {
  type: string
  part: string
  external: boolean
}

function relationshipsOf(relsXml: string): Map<string, Relationship> {
  const relationships = new Map<string, Relationship>()
  for (const match of relsXml.matchAll(/<(?:[\w.-]+:)?Relationship\b([^>]*)>/g)) {
    const attrs = attributes(match[1]!)
    const id = attrs.get('Id')
    if (!id) continue
    relationships.set(id, {
      type: attrs.get('Type') ?? '',
      part: resolveTarget(attrs.get('Target') ?? ''),
      external: attrs.get('TargetMode') === 'External',
    })
  }
  return relationships
}

function sheetsOf(
  workbookXml: string,
  relationships: Map<string, Relationship>,
  parts: Map<string, PartLocation>
): SheetPart[] {
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
    if (!parts.has(relationship.part)) refuse()
    sheets.push({ name, part: relationship.part })
  }
  if (sheets.length === 0) refuse()
  return sheets
}

function partOfType(
  relationships: Map<string, Relationship>,
  type: string,
  parts: Map<string, PartLocation>
) {
  for (const relationship of relationships.values()) {
    if (!relationship.external && relationship.type.endsWith(type)) {
      if (!parts.has(relationship.part)) refuse()
      return relationship.part
    }
  }
  return null
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
    const parts = new Map<string, PartLocation>()
    for (const entry of entries) {
      if (parts.has(entry.name)) refuse()
      const dataStart = await checkLocalHeader(file, entry, directoryOffset)
      parts.set(entry.name, {
        method: entry.method,
        dataStart,
        compressedSize: entry.compressedSize,
        size: entry.size,
      })
    }

    const workbook = parts.get(WORKBOOK)
    const rels = parts.get(WORKBOOK_RELS)
    if (!workbook || !rels) refuse()
    const relationships = relationshipsOf(await readSmallPart(file, rels))
    const sheets = sheetsOf(await readSmallPart(file, workbook), relationships, parts)
    if (sheets.length > MAX_SHEETS) {
      throw new ArchiveError(
        'too_many_sheets',
        `The workbook has ${sheets.length} sheets; the limit is ${MAX_SHEETS}. ` +
          'Remove the sheets that do not hold call records, or split the file.'
      )
    }
    const sheetParts = sheets.flatMap((sheet) => (sheet.part ? [sheet.part] : []))
    if (new Set(sheetParts).size !== sheetParts.length) {
      refuse('Two or more sheets of this workbook share one worksheet. Export the file again.')
    }
    return {
      entries: entries.length,
      unpackedBytes,
      sheets,
      parts,
      workbook: WORKBOOK,
      workbookRels: WORKBOOK_RELS,
      sharedStrings: partOfType(relationships, '/sharedStrings', parts),
      styles: partOfType(relationships, '/styles', parts),
    }
  } finally {
    await file.close()
  }
}
