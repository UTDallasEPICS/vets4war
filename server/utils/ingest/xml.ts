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
// It is a small state machine over the text, tag by tag (tags.ts), so its work is
// linear in the size of the part whatever the part holds, and each chunk is handled
// as it arrives: nothing waits for the end of a row. Only one tag, comment
// or CDATA section, or one inline string, is ever held, up to MAX_HELD_CHARS.
import { StringDecoder } from 'node:string_decoder'
import { Transform, type TransformCallback } from 'node:stream'
import { Finder, closeOf, localName, readTag, tagEnd, type Tag } from './tags'

export type PartKind = 'worksheet' | 'sharedStrings' | 'workbook' | 'other'

// One tag, comment, CDATA section or inline string longer than this is not part of a
// call-records export (an Excel cell holds at most 32,767 characters).
export const MAX_HELD_CHARS = 1024 * 1024
// Excel's last column is XFD: no row of a real worksheet has more cells.
export const MAX_CELLS_PER_ROW = 16_384

const SPREADSHEET_NAMESPACES = [
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main',
]
// Elements that cannot appear inside an inline string: meeting one there means the
// markup is broken, and reading on would swallow cells.
const NOT_IN_INLINE = new Set(['c', 'row', 'is', 'v', 'f', 'sheetData', 'worksheet'])

export class PartTooLargeError extends Error {
  constructor() {
    super('a row, tag or text of this workbook is too large to read')
    this.name = 'PartTooLargeError'
  }
}

export class MalformedPartError extends Error {
  constructor(what: string) {
    super(`the workbook's XML is broken (${what})`)
    this.name = 'MalformedPartError'
  }
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

const escapeText = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// The tag text with one attribute set: replaced in place, or added after the name.
function withAttribute(text: string, tag: Tag, name: string, value: string): string {
  const found = tag.attributes.find((a) => a.name === name)
  if (found) return text.slice(0, found.valueStart) + value + text.slice(found.valueEnd)
  return `${text.slice(0, tag.nameEnd)} ${name}="${value}"${text.slice(tag.nameEnd)}`
}

type State = 'normal' | 'formula' | 'inline' | 'phonetic'

export function createPartNormalizer(kind: PartKind): Transform {
  const decoder = new StringDecoder('utf8')
  let held = '' // the start of a construct not complete yet
  let rootSeen = false
  let prefix: string | null = null
  let state: State = 'normal'
  let afterPhonetic: State = 'normal'
  let runs: string[] = []
  let runChars = 0
  let inText = false
  let row = 0
  let column = 0
  let cells = 0

  function addRun(text: string) {
    runChars += text.length
    if (runChars > MAX_HELD_CHARS) throw new PartTooLargeError()
    runs.push(text)
  }

  function rowTag(tagText: string, tag: Tag): string {
    column = 0
    cells = 0
    const digits = tag.attributes.find((a) => a.name === 'r')?.value.match(/^\d+$/)
    if (digits) {
      row = Number(digits[0])
      return tagText
    }
    row++
    return withAttribute(tagText, tag, 'r', String(row))
  }

  // The usual cell (r="B12", not an ISO date cell) needs no rewrite: read its column
  // from the text without parsing every attribute.
  function plainCell(tagText: string): boolean {
    if (tagText.includes('t="d"') || tagText.includes("t='d'")) return false
    const at = tagText.indexOf(' r="')
    if (at === -1) return false
    let end = at + 4
    for (; end < tagText.length; end++) {
      const ch = tagText.charCodeAt(end) | 32 // lower case
      if (ch < 97 || ch > 122) break
    }
    if (end === at + 4) return false
    if (++cells > MAX_CELLS_PER_ROW) throw new PartTooLargeError()
    column = columnNumber(tagText.slice(at + 4, end).toUpperCase())
    return true
  }

  function cellTag(tagText: string, tag: Tag): string {
    if (++cells > MAX_CELLS_PER_ROW) throw new PartTooLargeError()
    let out = tagText
    let current = tag
    if (tag.attributes.find((a) => a.name === 't')?.value === 'd') {
      out = withAttribute(out, current, 't', 'str')
      current = readTag(out)
    }
    const letters = current.attributes.find((a) => a.name === 'r')?.value.match(/^[A-Za-z]+/)
    if (letters) {
      column = columnNumber(letters[0].toUpperCase())
      return out
    }
    column++
    return withAttribute(out, current, 'r', `${columnLetters(column)}${row}`)
  }

  // Names that may need a rewrite, or a change of state, in each kind of part. Every
  // other tag in the normal state is passed on as it is, without reading its attributes.
  const WATCHED: Record<PartKind, Set<string>> = {
    worksheet: new Set(['f', 'row', 'c', 'is']),
    sharedStrings: new Set(['rPh', 'phoneticPr']),
    workbook: new Set(['workbookPr']),
    other: new Set(),
  }

  // The name of the tag input[start..end], read up to the first space, '/' or '>'.
  function quickName(input: string, start: number, end: number) {
    const closing = input.charCodeAt(start + 1) === 47 // '/'
    const from = closing ? start + 2 : start + 1
    let j = from
    for (; j < end; j++) {
      const ch = input.charCodeAt(j)
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 47 || ch === 62) break
    }
    return { closing, name: input.slice(from, j) }
  }

  // One element tag. Returns what to write instead of it, or undefined to pass it on.
  function element(input: string, start: number, end: number): string | undefined {
    const quick = quickName(input, start, end)
    const closing = quick.closing
    let name = quick.name
    if (state === 'normal' && rootSeen && prefix === null && !WATCHED[kind].has(name)) {
      return undefined // the common case: nothing to read, nothing to change
    }
    const raw = input.slice(start, end + 1)
    let tagText = raw
    let changed = false
    if (!rootSeen && !closing) {
      rootSeen = true
      for (const a of readTag(raw).attributes) {
        if (a.name.startsWith('xmlns:') && SPREADSHEET_NAMESPACES.includes(a.value)) {
          prefix = a.name.slice('xmlns:'.length)
        }
      }
    }
    if (prefix !== null && name.startsWith(`${prefix}:`)) {
      const start = closing ? 2 : 1
      name = localName(name)
      tagText = raw.slice(0, start) + name + raw.slice(start + prefix.length + 1 + name.length)
      changed = true
    }
    if (state === 'normal' && !WATCHED[kind].has(name)) return changed ? tagText : undefined
    if (state === 'normal' && kind === 'worksheet' && name === 'c' && !closing) {
      if (plainCell(tagText)) return changed ? tagText : undefined
    }
    const tag = readTag(tagText)
    switch (state) {
      case 'formula':
        if (closing && name === 'f') state = 'normal'
        else throw new MalformedPartError(`<${name}> inside a formula`)
        return ''
      case 'phonetic':
        if (closing && name === 'rPh') state = afterPhonetic
        else if (name !== 't') throw new MalformedPartError(`<${name}> inside a phonetic guide`)
        return ''
      case 'inline':
        if (closing && name === 'is') {
          state = 'normal'
          return `<is><t xml:space="preserve">${runs.join('')}</t></is>`
        }
        if (name === 't' && !tag.selfClosing) inText = !closing
        else if (name === 'rPh' && !closing && !tag.selfClosing) {
          afterPhonetic = 'inline'
          state = 'phonetic'
        } else if (NOT_IN_INLINE.has(name)) {
          throw new MalformedPartError(`<${name}> inside an inline string`)
        }
        return ''
      case 'normal':
        break
    }
    if (closing) return changed ? tagText : undefined
    if (kind === 'worksheet') {
      if (name === 'f') {
        if (!tag.selfClosing) state = 'formula'
        return ''
      }
      if (name === 'row') return rowTag(tagText, tag)
      if (name === 'c') return cellTag(tagText, tag)
      if (name === 'is' && !tag.selfClosing) {
        state = 'inline'
        runs = []
        runChars = 0
        inText = false
        return ''
      }
    }
    if (kind === 'sharedStrings') {
      if (name === 'phoneticPr') return ''
      if (name === 'rPh') {
        if (!tag.selfClosing) {
          afterPhonetic = 'normal'
          state = 'phonetic'
        }
        return ''
      }
    }
    if (kind === 'workbook' && name === 'workbookPr') {
      if (tag.attributes.find((a) => a.name === 'date1904')?.value === 'true') {
        return withAttribute(tagText, tag, 'date1904', '1')
      }
    }
    return changed ? tagText : undefined
  }

  // Handles the text from the start: what to pass on, and the incomplete construct at
  // the end that waits for more text. Unchanged stretches are passed on as slices of the
  // input, so an honest part costs one copy.
  function handle(input: string, final: boolean): { out: string[]; rest: string } {
    const finder = new Finder(input)
    const out: string[] = []
    let copyFrom = 0 // start of the stretch passed on unchanged (normal state only)
    const flushTo = (at: number) => {
      if (at > copyFrom) out.push(input.slice(copyFrom, at))
    }
    let i = 0
    while (i < input.length) {
      const lt = finder.lt.next(i)
      const textEnd = lt === -1 ? input.length : lt
      if (state !== 'normal' && textEnd > i) {
        if (state === 'inline' && inText) addRun(input.slice(i, textEnd))
        copyFrom = textEnd
      }
      if (lt === -1) break
      let end: number
      let kindOf: 'comment' | 'cdata' | 'other' | 'element'
      const second = input.charCodeAt(lt + 1)
      if (second === 33 /* ! */ && input.startsWith('<!--', lt)) {
        end = closeOf(finder, '-->', lt + 4)
        kindOf = 'comment'
      } else if (second === 33 && input.startsWith('<![CDATA[', lt)) {
        end = closeOf(finder, ']]>', lt + 9)
        kindOf = 'cdata'
      } else if (second === 63 /* ? */) {
        end = closeOf(finder, '?>', lt + 2)
        kindOf = 'other'
      } else {
        end = tagEnd(finder, lt)
        kindOf = second === 33 ? 'other' : 'element'
      }
      if (end === -1) {
        if (state === 'normal') flushTo(lt)
        if (final) {
          // Broken at the very end: pass it on, the XML reader refuses it.
          if (state === 'normal') out.push(input.slice(lt))
          return { out, rest: '' }
        }
        if (input.length - lt > MAX_HELD_CHARS) throw new PartTooLargeError()
        return { out, rest: input.slice(lt) }
      }
      const before = state
      let replacement: string | undefined
      if (kindOf === 'element') replacement = element(input, lt, end)
      else if (before === 'inline' && inText && kindOf === 'cdata') {
        addRun(escapeText(input.slice(lt + 9, end - 2)))
      }
      if (before !== 'normal') {
        // Everything read while not in the normal state is consumed here.
        if (replacement) out.push(replacement)
        copyFrom = end + 1
      } else if (replacement !== undefined) {
        flushTo(lt)
        if (replacement) out.push(replacement)
        copyFrom = end + 1
      }
      i = end + 1
    }
    if (state === 'normal') flushTo(input.length)
    return { out, rest: '' }
  }

  function run(input: string, final: boolean): string | undefined {
    const { out, rest } = handle(held + input, final)
    held = rest
    return out.join('') || undefined
  }

  return new Transform({
    decodeStrings: false,
    encoding: 'utf8',
    transform(chunk: string | Buffer, _encoding, done: TransformCallback) {
      try {
        done(null, run(typeof chunk === 'string' ? chunk : decoder.write(chunk), false))
      } catch (error) {
        done(error as Error)
      }
    },
    flush(done: TransformCallback) {
      try {
        done(null, run(decoder.end(), true))
      } catch (error) {
        done(error as Error)
      }
    },
  })
}
