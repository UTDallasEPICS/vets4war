// Scanning XML text without regular expressions that can backtrack. Everything here is
// linear in the length of the text, whatever it holds: a crafted part full of unclosed
// tags, quotes or long words costs as much as an honest part of the same size (review
// N-2: lazy patterns such as <f>[\s\S]*?</f> are quadratic on unclosed tags).

// indexOf with memory, for one needle: a search from `from` reuses the previous answer
// when it still holds, so the searches over one text, made at increasing positions,
// read each character at most once.
class Cursor {
  private from = -1
  private at = -1

  constructor(
    private readonly text: string,
    private readonly needle: string
  ) {}

  next(from: number): number {
    if (this.from !== -1 && this.from <= from && (this.at === -1 || this.at >= from)) {
      return this.at
    }
    this.from = from
    this.at = this.text.indexOf(this.needle, from)
    return this.at
  }
}

// The cursors one scan of a text needs: '<', '>' and the two quotes.
export class Finder {
  readonly lt: Cursor
  readonly gt: Cursor
  readonly dq: Cursor
  readonly sq: Cursor

  constructor(readonly text: string) {
    this.lt = new Cursor(text, '<')
    this.gt = new Cursor(text, '>')
    this.dq = new Cursor(text, '"')
    this.sq = new Cursor(text, "'")
  }
}

// The '>' that ends the tag starting at `start` (a '<'), skipping quoted attribute
// values (they may hold '>'); -1 when the tag is not complete in the text.
export function tagEnd(finder: Finder, start: number): number {
  let from = start + 1
  for (;;) {
    const gt = finder.gt.next(from)
    if (gt === -1) return -1
    const dq = finder.dq.next(from)
    const sq = finder.sq.next(from)
    const quote = dq === -1 ? sq : sq === -1 ? dq : Math.min(dq, sq)
    if (quote === -1 || quote > gt) return gt
    const close = (finder.text[quote] === '"' ? finder.dq : finder.sq).next(quote + 1)
    if (close === -1) return -1
    from = close + 1
  }
}

export interface Attribute {
  name: string
  value: string // as written (entities not decoded)
  valueStart: number // offsets in the tag text
  valueEnd: number
}

export interface Tag {
  closing: boolean
  selfClosing: boolean
  name: string // as written, with any prefix
  nameStart: number
  nameEnd: number
  attributes: Attribute[]
}

const isSpace = (ch: string | undefined) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'

// One tag's text, from '<' to '>' inclusive. A malformed attribute ends the attribute
// list (the XML reader downstream refuses the part anyway).
export function readTag(text: string): Tag {
  let i = 1
  const closing = text[i] === '/'
  if (closing) i++
  const nameStart = i
  while (i < text.length && !isSpace(text[i]) && text[i] !== '/' && text[i] !== '>') i++
  const nameEnd = i
  const attributes: Attribute[] = []
  for (;;) {
    while (isSpace(text[i])) i++
    if (i >= text.length || text[i] === '/' || text[i] === '>') break
    const attrStart = i
    while (i < text.length && !isSpace(text[i]) && text[i] !== '=' && text[i] !== '>') i++
    const name = text.slice(attrStart, i)
    while (isSpace(text[i])) i++
    if (text[i] !== '=') break
    i++
    while (isSpace(text[i])) i++
    const quote = text[i]
    if (quote !== '"' && quote !== "'") break
    const close = text.indexOf(quote, i + 1)
    if (close === -1) break
    attributes.push({ name, value: text.slice(i + 1, close), valueStart: i + 1, valueEnd: close })
    i = close + 1
  }
  return {
    closing,
    selfClosing: !closing && text.length >= 2 && text[text.length - 2] === '/',
    name: text.slice(nameStart, nameEnd),
    nameStart,
    nameEnd,
    attributes,
  }
}

export function localName(name: string): string {
  const colon = name.indexOf(':')
  return colon === -1 ? name : name.slice(colon + 1)
}

// The start tags of the elements called `local` (any prefix), in order. Comments,
// processing instructions and CDATA sections are skipped; an incomplete tag ends the scan.
export function startTags(xml: string, local: string): Tag[] {
  const finder = new Finder(xml)
  const tags: Tag[] = []
  let i = 0
  for (;;) {
    const lt = finder.lt.next(i)
    if (lt === -1) return tags
    let end: number
    if (xml.startsWith('<!--', lt)) end = closeOf(finder, '-->', lt + 4)
    else if (xml.startsWith('<![CDATA[', lt)) end = closeOf(finder, ']]>', lt + 9)
    else if (xml.startsWith('<?', lt)) end = closeOf(finder, '?>', lt + 2)
    else {
      end = tagEnd(finder, lt)
      if (end !== -1) {
        const tag = readTag(xml.slice(lt, end + 1))
        if (!tag.closing && localName(tag.name) === local) tags.push(tag)
      }
    }
    if (end === -1) return tags // not complete
    i = end + 1
  }
}

// The index of the last character of `marker` found from `from`, or -1. Callers stop
// at the first construct that is not complete, so each text is searched once.
export function closeOf(finder: Finder, marker: string, from: number): number {
  const at = finder.text.indexOf(marker, from)
  return at === -1 ? -1 : at + marker.length - 1
}

export function attribute(tag: Tag, name: string): string | undefined {
  return tag.attributes.find((a) => a.name === name)?.value
}
