// SYNTHETIC workbooks written by hand, part by part, so a test can carry markup that
// Excel and other export tools write but the exceljs writer never does: ISO date cells,
// formulas with cached results, the 1904 date system, rows without references,
// prefixed element names, phonetic guides, rich-text inline strings.
import { buildZip } from './zip'

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'

export const HEADER_ROW = [
  'Skill_Name',
  'Start_Date',
  'start_time',
  'InQueue',
  'Agent_Time',
  'Abandon_Time',
  'Routing_Time',
  'Abandon',
]
// cellXfs: 0 General, 1 date (numFmt 14), 2 time (numFmt 21)
export const DATE_STYLE = 1
export const TIME_STYLE = 2

export const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const inlineText = (ref: string, text: string) =>
  `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(text)}</t></is></c>`

export const headerRow = (columns = HEADER_ROW) =>
  `<row r="1">${columns.map((name, i) => inlineText(`${String.fromCharCode(65 + i)}1`, name)).join('')}</row>`

// One call as cells B..H of row r, in the usual cell types; `over` replaces cells by column letter.
export function callRow(
  r: number,
  call: { serialDay: number; dayFraction: number; durations: number[]; flag: string },
  over: Record<string, string> = {}
): string {
  const cells: Record<string, string> = {
    A: inlineText(`A${r}`, 'Vets4Warriors_Call'),
    B: `<c r="B${r}" s="${DATE_STYLE}"><v>${call.serialDay}</v></c>`,
    C: `<c r="C${r}" s="${TIME_STYLE}"><v>${call.dayFraction}</v></c>`,
    D: `<c r="D${r}"><v>${call.durations[0]}</v></c>`,
    E: `<c r="E${r}"><v>${call.durations[1]}</v></c>`,
    F: `<c r="F${r}"><v>${call.durations[2]}</v></c>`,
    G: `<c r="G${r}"><v>${call.durations[3]}</v></c>`,
    H: inlineText(`H${r}`, call.flag),
    ...over,
  }
  return `<row r="${r}">${Object.keys(cells)
    .sort()
    .map((k) => cells[k])
    .join('')}</row>`
}

// Serial day of a date in the 1900 (default) or 1904 date system.
export function serialDay(iso: string, date1904 = false): number {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - epoch) / 86_400_000)
}

export function handmadeWorkbook(options: {
  rows: string // the <row> elements of the one sheet
  sharedStrings?: string // the <si> elements
  date1904?: '1' | 'true'
  prefix?: string // e.g. 'x' writes <x:worksheet xmlns:x=...> and <x:row> etc.
}): Buffer {
  const p = options.prefix ? `${options.prefix}:` : ''
  const ns = options.prefix ? `xmlns:${options.prefix}="${MAIN}"` : `xmlns="${MAIN}"`
  const rows = options.prefix
    ? options.rows.replace(/<(\/?)(row|c|v|f|is|t|r)\b/g, `<$1${p}$2`)
    : options.rows
  const workbookPr = options.date1904 ? `<${p}workbookPr date1904="${options.date1904}"/>` : ''
  const parts: Record<string, string> = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/></Types>',
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml':
      `<?xml version="1.0" encoding="UTF-8"?><${p}workbook ${ns} xmlns:r="${REL}">${workbookPr}` +
      `<${p}sheets><${p}sheet name="Calls" sheetId="1" r:id="rId1"/></${p}sheets></${p}workbook>`,
    'xl/_rels/workbook.xml.rels':
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}">` +
      `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId3" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    'xl/styles.xml':
      `<?xml version="1.0" encoding="UTF-8"?><${p}styleSheet ${ns}><${p}cellXfs count="3">` +
      `<${p}xf numFmtId="0"/><${p}xf numFmtId="14" applyNumberFormat="1"/><${p}xf numFmtId="21" applyNumberFormat="1"/>` +
      `</${p}cellXfs></${p}styleSheet>`,
    'xl/sharedStrings.xml':
      `<?xml version="1.0" encoding="UTF-8"?><${p}sst ${ns}>` +
      (options.prefix
        ? (options.sharedStrings ?? '').replace(/<(\/?)(si|t|r|rPh)\b/g, `<$1${p}$2`)
        : (options.sharedStrings ?? '')) +
      `</${p}sst>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><${p}worksheet ${ns} xmlns:r="${REL}"><${p}sheetData>${rows}</${p}sheetData></${p}worksheet>`,
  }
  return buildZip(Object.entries(parts).map(([name, data]) => ({ name, data })))
}
