// Rewrites the XML of a workbook part, as it streams, into the narrow shape exceljs'
// streaming reader handles correctly. Real files carry markup that the reader either
// misreads without a word or chokes on, and the Python parser (openpyxl, data_only)
// reads all of it:
//
// - a formula cell is read by its cached result, as Excel shows it. exceljs drops a
//   cached 0 or "" (the cell reads as empty), loses the shared-formula children's
//   formula, and never applies the date format to a cached result. So formulas are
//   removed and the cached value stays: <c><f>A1+0</f><v>0</v></c> -> <c><v>0</v></c>.
// - an ISO 8601 date cell (t="d") is read by exceljs as parseFloat("2026-11-10...") =
//   2026, i.e. a date in 1905, silently. It becomes a text cell (t="str"); the parser
//   reads ISO date text.
// - rows and cells without an `r` reference (allowed, and written by some export
//   tools) crash the reader; they get the reference their position gives them.
// - an inline string made of rich-text runs keeps only its last run in exceljs; the
//   runs are joined into one text.
// - phonetic guides in shared strings (<rPh>) are appended to the text by exceljs;
//   they are removed (they are not part of the cell's value).
// - elements written with a namespace prefix (<x:row>) are not recognised at all; the
//   prefix of the spreadsheet namespace is removed.
// - date1904="true" (a valid spelling) is not recognised; it becomes "1".
//
// The text is cut only after complete units (a row, a shared string, a tag), so a
// rewrite never sees half an element.
import { StringDecoder } from 'node:string_decoder'
import { Transform, type TransformCallback } from 'node:stream'

export type PartKind = 'worksheet' | 'sharedStrings' | 'workbook' | 'other'

// A unit bigger than this (one row of one sheet) is not a call-records export.
export const MAX_UNIT_CHARS = 16 * 1024 * 1024

const SPREADSHEET_NAMESPACES = [
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main',
]

export class PartTooLargeError extends Error {
  constructor() {
    super('a single row of this workbook is too large to read')
    this.name = 'PartTooLargeError'
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The prefix bound to the spreadsheet namespace on the root element, if any.
function spreadsheetPrefix(head: string): string | null {
  for (const match of head.matchAll(/xmlns:([A-Za-z_][\w.-]*)\s*=\s*["']([^"']*)["']/g)) {
    if (SPREADSHEET_NAMESPACES.includes(match[2]!)) return match[1]!
  }
  return null
}

function columnNumber(letters: string): number {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

function columnLetters(n: number): string {
  let letters = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    letters = String.fromCharCode(65 + rem) + letters
    n = Math.floor((n - 1) / 26)
  }
  return letters
}

const FORMULA = /<f\b[^>]*\/>|<f\b[^>]*>[\s\S]*?<\/f>/g
const PHONETIC = /<rPh\b[^>]*>[\s\S]*?<\/rPh>|<phoneticPr\b[^>]*\/>/g
const TEXT_RUN = /<t\b[^>]*>([\s\S]*?)<\/t>/g
const ROW_CELL_OR_INLINE = /<row\b([^>]*?)(\/?)>|<c\b([^>]*?)(\/?)>|<is>([\s\S]*?)<\/is>/g
const R_ATTRIBUTE = /\sr\s*=\s*["']([A-Za-z]*)(\d*)["']/
const ISO_DATE_TYPE = /(\st\s*=\s*)(["'])d\2/

export function createPartNormalizer(kind: PartKind): Transform {
  let raw = '' // text after the last complete tag
  let units = '' // complete tags not yet ending a unit
  let prefix: RegExp | null | undefined // undefined: root not seen yet
  let row = 0
  let column = 0
  const decoder = new StringDecoder('utf8')

  const unitEnd = kind === 'worksheet' ? '</row>' : kind === 'sharedStrings' ? '</si>' : null

  let head = '' // text before the root element's start tag is complete

  // The prefix is decided by the root element's own namespace declarations, so the
  // text is held until that start tag is complete (a chunk may end before it).
  function unprefix(text: string): string | null {
    if (prefix === undefined) {
      head += text
      const root = /<(?![?!])[^>]*>/.exec(head)
      if (!root) {
        if (head.length > MAX_UNIT_CHARS) throw new PartTooLargeError()
        return null
      }
      const found = spreadsheetPrefix(root[0])
      prefix = found ? new RegExp(`<(/?)${escapeRegExp(found)}:`, 'g') : null
      text = head
      head = ''
    }
    return prefix ? text.replace(prefix, '<$1') : text
  }

  function rewriteRows(text: string): string {
    return text
      .replace(FORMULA, '')
      .replace(
        ROW_CELL_OR_INLINE,
        (
          whole,
          rowAttrs?: string,
          rowEnd?: string,
          cellAttrs?: string,
          cellEnd?: string,
          inline?: string
        ) => {
          if (rowAttrs !== undefined) {
            const ref = R_ATTRIBUTE.exec(rowAttrs)
            column = 0
            if (ref && ref[2]) {
              row = Number(ref[2])
              return whole
            }
            row++
            return `<row r="${row}"${rowAttrs}${rowEnd}>`
          }
          if (cellAttrs !== undefined) {
            let attrs = cellAttrs.replace(ISO_DATE_TYPE, '$1$2str$2')
            const ref = R_ATTRIBUTE.exec(attrs)
            if (ref && ref[1]) {
              column = columnNumber(ref[1].toUpperCase())
            } else {
              column++
              attrs = ` r="${columnLetters(column)}${row}"${attrs.replace(R_ATTRIBUTE, '')}`
            }
            return `<c${attrs}${cellEnd}>`
          }
          const runs = [...inline!.replace(PHONETIC, '').matchAll(TEXT_RUN)].map((m) => m[1])
          return `<is><t xml:space="preserve">${runs.join('')}</t></is>`
        }
      )
  }

  function rewrite(text: string): string {
    switch (kind) {
      case 'worksheet':
        return rewriteRows(text)
      case 'sharedStrings':
        return text.replace(PHONETIC, '')
      case 'workbook':
        return text.replace(/(\sdate1904\s*=\s*)(["'])true\2/, '$1$21$2')
      default:
        return text
    }
  }

  function take(text: string, final: boolean): string {
    const plain = unprefix(text)
    if (plain === null) {
      if (!final) return ''
      units += head // a part without a root element: nothing to rewrite
      head = ''
    } else units += plain
    if (final || unitEnd === null) {
      const out = units
      units = ''
      return rewrite(out)
    }
    const cut = units.lastIndexOf(unitEnd)
    if (cut < 0) {
      if (units.length > MAX_UNIT_CHARS) throw new PartTooLargeError()
      return ''
    }
    const ready = units.slice(0, cut + unitEnd.length)
    units = units.slice(cut + unitEnd.length)
    return rewrite(ready)
  }

  return new Transform({
    decodeStrings: false,
    encoding: 'utf8',
    transform(chunk: string | Buffer, _encoding, done: TransformCallback) {
      try {
        raw += typeof chunk === 'string' ? chunk : decoder.write(chunk)
        const lastTag = raw.lastIndexOf('>')
        if (lastTag < 0) {
          if (raw.length > MAX_UNIT_CHARS) throw new PartTooLargeError()
          return done()
        }
        const complete = raw.slice(0, lastTag + 1)
        raw = raw.slice(lastTag + 1)
        const out = take(complete, false)
        done(null, out || undefined)
      } catch (error) {
        done(error as Error)
      }
    },
    flush(done: TransformCallback) {
      try {
        const out = take(raw + decoder.end(), true)
        raw = ''
        done(null, out || undefined)
      } catch (error) {
        done(error as Error)
      }
    },
  })
}
