"""SYNTHETIC workbooks written the way Excel (and other export tools) write them.

openpyxl and exceljs write only a narrow slice of what a real .xlsx can hold. This
module writes the package by hand (zipfile + XML text), so each case can carry the
exact markup a real file may carry: shared and inline strings, rich-text runs, the
1904 date system, ISO 8601 date cells (t="d"), formulas with cached results (also
shared formulas, cached zero, cached errors, no cached value), built-in and custom
number formats, frozen panes and filters, hidden and very hidden sheets, a chart
sheet, empty leading rows and columns, rows and cells without `r` references,
prefixed element names, and long sheets.

Every value is made up; no real call data is read or written.

    CASES: {file name: writer(path)}   (used by make_cases.py)
"""

from __future__ import annotations

import zipfile
from datetime import date, timedelta
from pathlib import Path
from xml.sax.saxutils import escape

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
# Excel's own worksheet root carries these markup-compatibility namespaces.
EXCEL_WORKSHEET_ATTRS = (
    f'xmlns="{MAIN_NS}" xmlns:r="{REL_NS}" '
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac xr xr2 xr3" '
    'xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" '
    'xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" '
    'xmlns:xr2="http://schemas.microsoft.com/office/spreadsheetml/2015/revision2" '
    'xmlns:xr3="http://schemas.microsoft.com/office/spreadsheetml/2016/revision3" '
    'xr:uid="{00000000-0001-0000-0000-000000000000}"'
)

HEADER = ["Skill_Name", "Start_Date", "start_time", "InQueue", "Agent_Time",
          "Abandon_Time", "Routing_Time", "Abandon"]
SKILL = "Vets4Warriors_Call"

# Styles: index into cellXfs. 0 General, 1 date (14), 2 time (21), then customs.
CUSTOM_FORMATS = {
    164: "yyyy\\-mm\\-dd",
    165: "[$-409]h:mm:ss\\ AM/PM;@",
    166: "dd/mm/yyyy",
    167: "[$-F800]dddd\\,\\ mmmm\\ dd\\,\\ yyyy",
    168: "[$-F400]h:mm:ss\\ AM/PM",
    169: "0",
}
XF_NUMFMTS = [0, 14, 21, 164, 165, 166, 167, 168, 22, 20, 46, 169, 49]
STYLE = {"general": 0, "date": 1, "time": 2, "iso_date": 3, "us_time": 4, "dmy_date": 5,
         "long_date": 6, "system_time": 7, "datetime": 8, "hmm": 9, "elapsed": 10,
         "integer": 11, "text": 12}


def calls(day_count: int = 2, per_day: int = 24, first: date = date(2026, 11, 10)):
    """(day, seconds of day, in_queue, agent, abandon, routing, flag): calls from
    00:xx to 23:xx on each day, a hang-up every fourth call."""
    rows = []
    for d in range(day_count):
        day = first + timedelta(days=d)
        for k in range(per_day):
            seconds = (k * 86399) // max(per_day - 1, 1)
            abandoned = k % 4 == 1
            rows.append((day, seconds, 5 + k, 0 if abandoned else 300 + 7 * k,
                         12 + k if abandoned else 0, 3, "Y" if abandoned else "N"))
    return rows


def serial_day(day: date, date1904: bool = False) -> int:
    epoch = date(1904, 1, 1) if date1904 else date(1899, 12, 30)
    return (day - epoch).days


def serial_time(seconds: int) -> str:
    return repr(seconds / 86400)


def col(index: int) -> str:
    """0 -> A"""
    name = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        name = chr(65 + rem) + name
    return name


# A cell is a dict: {"t": None|"s"|"inlineStr"|"str"|"b"|"e"|"d"|"n", "v": text|None,
# "s": style index, "f": formula text|None, "f_attrs": str, "rich": [runs]}
def text(value, inline=False):
    return {"t": "inlineStr" if inline else "s", "v": value}


def number(value, style="general"):
    return {"t": None, "v": repr(value) if isinstance(value, float) else str(value), "s": STYLE[style]}


def default_row(call, *, date1904=False, inline=False, date_style="date", time_style="time"):
    day, seconds, inq, agent, aband, routing, flag = call
    return [text(SKILL, inline), number(serial_day(day, date1904), date_style),
            {"t": None, "v": serial_time(seconds), "s": STYLE[time_style]},
            number(inq), number(agent), number(aband), number(routing), text(flag, inline)]


class Book:
    """Collects sheets, then writes an Excel-shaped package."""

    def __init__(self, *, date1904=False, prefix="", shared_strings=True):
        self.date1904 = date1904
        self.prefix = prefix          # e.g. "x:" for prefixed element names
        self.shared_strings = shared_strings
        self.sheets = []               # (name, state, kind, xml or None)
        self.strings: list[str] = []
        self.string_index: dict[str, int] = {}
        self.phonetic: dict[str, str] = {}

    def _sst(self, value: str) -> int:
        if value not in self.string_index:
            self.string_index[value] = len(self.strings)
            self.strings.append(value)
        return self.string_index[value]

    def _cell_xml(self, ref, cell, refs=True):
        p = self.prefix
        attrs = f' r="{ref}"' if refs else ""
        if cell.get("s"):
            attrs += f' s="{cell["s"]}"'
        t = cell.get("t")
        inner = ""
        if cell.get("f") is not None:
            f_attrs = cell.get("f_attrs", "")
            inner += f"<{p}f{f_attrs}>{escape(cell['f'])}</{p}f>" if cell["f"] else f"<{p}f{f_attrs}/>"
        if t == "s":
            if self.shared_strings:
                attrs += ' t="s"'
                inner += f"<{p}v>{self._sst(cell['v'])}</{p}v>"
            else:
                t = "inlineStr"
        if t == "inlineStr":
            attrs += ' t="inlineStr"'
            runs = cell.get("rich")
            if runs:
                body = "".join(f"<{p}r><{p}t xml:space=\"preserve\">{escape(r)}</{p}t></{p}r>" for r in runs)
            else:
                body = f"<{p}t xml:space=\"preserve\">{escape(cell['v'])}</{p}t>"
            inner += f"<{p}is>{body}</{p}is>"
        elif t in ("str", "b", "e", "d"):
            attrs += f' t="{t}"'
            if cell.get("v") is not None:
                inner += f"<{p}v>{escape(str(cell['v']))}</{p}v>"
        elif t != "s" and cell.get("v") is not None:
            inner += f"<{p}v>{cell['v']}</{p}v>"
        return f"<{p}c{attrs}>{inner}</{p}c>" if inner else f"<{p}c{attrs}/>"

    def add_sheet(self, name, rows, *, state=None, first_row=1, first_col=0, refs=True,
                  frozen=False, autofilter=False, extra_tail=""):
        """rows: list of lists of cells (None = no cell). Rows are written from
        first_row, cells from column first_col."""
        p = self.prefix
        out = []
        last_col = first_col
        for i, row in enumerate(rows):
            r = first_row + i
            cells = []
            for j, cell in enumerate(row):
                if cell is None:
                    continue
                last_col = max(last_col, first_col + j)
                cells.append(self._cell_xml(f"{col(first_col + j)}{r}", cell, refs))
            span = f' spans="{first_col + 1}:{first_col + len(row)}" x14ac:dyDescent="0.25"' if refs and not p else ""
            row_attrs = f' r="{r}"{span}' if refs else ""
            out.append(f"<{p}row{row_attrs}>{''.join(cells)}</{p}row>")
        last_row = first_row + max(len(rows), 1) - 1
        dim = f"{col(first_col)}{first_row}:{col(last_col)}{last_row}"
        views = '<sheetView tabSelected="1" workbookViewId="0">'
        if frozen:
            views += ('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
                      '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>')
        views += "</sheetView>"
        filt = f'<autoFilter ref="{dim}"/>' if autofilter else ""
        root_attrs = EXCEL_WORKSHEET_ATTRS if not p else f'xmlns:{p[:-1]}="{MAIN_NS}" xmlns:r="{REL_NS}"'
        if p:
            xml = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                   f"<{p}worksheet {root_attrs}><{p}sheetData>{''.join(out)}</{p}sheetData></{p}worksheet>")
        else:
            xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
                   f"<worksheet {root_attrs}><dimension ref=\"{dim}\"/><sheetViews>{views}</sheetViews>"
                   '<sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/>'
                   f"<sheetData>{''.join(out)}</sheetData>{filt}"
                   '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
                   f"{extra_tail}</worksheet>")
        self.sheets.append((name, state, "worksheet", xml))

    def add_chart_sheet(self, name):
        self.sheets.append((name, None, "chartsheet", None))

    def _styles(self):
        fmts = "".join(f'<numFmt numFmtId="{k}" formatCode="{escape(v, {chr(34): "&quot;"})}"/>'
                       for k, v in CUSTOM_FORMATS.items())
        xfs = "".join(
            f'<xf numFmtId="{n}" fontId="0" fillId="0" borderId="0" xfId="0"'
            + (' applyNumberFormat="1"' if n else "") + "/>"
            for n in XF_NUMFMTS)
        return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
                f'<styleSheet xmlns="{MAIN_NS}"><numFmts count="{len(CUSTOM_FORMATS)}">{fmts}</numFmts>'
                '<fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/>'
                '<scheme val="minor"/></font></fonts>'
                '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
                '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
                '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
                f'<cellXfs count="{len(XF_NUMFMTS)}">{xfs}</cellXfs>'
                '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
                '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>'
                "</styleSheet>")

    def _shared_strings(self):
        items = []
        for s in self.strings:
            ph = self.phonetic.get(s)
            extra = f'<rPh sb="0" eb="1"><t>{escape(ph)}</t></rPh><phoneticPr fontId="1"/>' if ph else ""
            items.append(f'<si><t xml:space="preserve">{escape(s)}</t>{extra}</si>')
        return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
                f'<sst xmlns="{MAIN_NS}" count="{len(self.strings)}" uniqueCount="{len(self.strings)}">'
                f"{''.join(items)}</sst>")

    def save(self, path: Path):
        sheet_entries, rels, overrides = [], [], []
        files = {}
        for i, (name, state, kind, xml) in enumerate(self.sheets, start=1):
            st = f' state="{state}"' if state else ""
            sheet_entries.append(f'<sheet name="{escape(name, {chr(34): "&quot;"})}" sheetId="{i}"{st} r:id="rId{i}"/>')
            if kind == "worksheet":
                files[f"xl/worksheets/sheet{i}.xml"] = xml
                rels.append(f'<Relationship Id="rId{i}" Type="{DOC_REL}/worksheet" Target="worksheets/sheet{i}.xml"/>')
                overrides.append(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
            else:
                files[f"xl/chartsheets/sheet{i}.xml"] = (
                    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
                    f'<chartsheet xmlns="{MAIN_NS}" xmlns:r="{REL_NS}"><sheetViews><sheetView workbookViewId="0"/></sheetViews>'
                    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></chartsheet>')
                files[f"xl/chartsheets/_rels/sheet{i}.xml.rels"] = (
                    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
                    f'<Relationships xmlns="{PKG_REL_NS}"></Relationships>')
                rels.append(f'<Relationship Id="rId{i}" Type="{DOC_REL}/chartsheet" Target="chartsheets/sheet{i}.xml"/>')
                overrides.append(f'<Override PartName="/xl/chartsheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml"/>')
        n = len(self.sheets)
        files["xl/styles.xml"] = self._styles()
        rels.append(f'<Relationship Id="rId{n + 1}" Type="{DOC_REL}/styles" Target="styles.xml"/>')
        if self.strings or self.shared_strings:
            files["xl/sharedStrings.xml"] = None  # filled after the sheets used it
            rels.append(f'<Relationship Id="rId{n + 2}" Type="{DOC_REL}/sharedStrings" Target="sharedStrings.xml"/>')
        pr = '<workbookPr date1904="1" defaultThemeVersion="166925"/>' if self.date1904 else '<workbookPr defaultThemeVersion="166925"/>'
        files["xl/workbook.xml"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
            f'<workbook xmlns="{MAIN_NS}" xmlns:r="{REL_NS}"><fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27425"/>'
            f'{pr}<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="12300"/></bookViews>'
            f'<sheets>{"".join(sheet_entries)}</sheets><calcPr calcId="191029"/></workbook>')
        files["xl/_rels/workbook.xml.rels"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
            f'<Relationships xmlns="{PKG_REL_NS}">{"".join(rels)}</Relationships>')
        files["_rels/.rels"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
            f'<Relationships xmlns="{PKG_REL_NS}"><Relationship Id="rId1" Type="{DOC_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        files["xl/sharedStrings.xml"] = self._shared_strings()
        files["[Content_Types].xml"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            f"{''.join(overrides)}"
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
            "</Types>")
        # Excel writes [Content_Types].xml first, then _rels, then xl/.
        order = ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"]
        order += [k for k in files if k not in order]
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
            for name in order:
                z.writestr(name, files[name])


def header_cells(inline=False):
    return [text(h, inline) for h in HEADER]


def simple(path, *, rows=None, book=None, **sheet_opts):
    book = book or Book()
    data = rows if rows is not None else [default_row(c, date1904=book.date1904) for c in calls()]
    book.add_sheet("Sheet1", [header_cells(not book.shared_strings)] + data, **sheet_opts)
    book.save(path)


def with_cells(transform, *, book=None, **opts):
    """A writer whose rows come from default_row then transform(row, call)."""
    def write(path):
        b = book() if book else Book()
        rows = [transform(default_row(c, date1904=b.date1904, inline=not b.shared_strings), c) for c in calls()]
        simple(path, rows=rows, book=b, **opts)
    return write


def _set(row, index, cell):
    row = list(row)
    row[index] = cell
    return row


def iso_dates(row, call):
    return _set(row, 1, {"t": "d", "v": f"{call[0].isoformat()}T00:00:00", "s": STYLE["date"]})


def iso_date_and_time(row, call):
    row = iso_dates(row, call)
    s = call[1]
    return _set(row, 2, {"t": "d", "v": f"1899-12-30T{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}", "s": STYLE["time"]})


def formula_durations(row, call):
    out = list(row)
    for i in (3, 4, 5, 6):
        out[i] = {"t": None, "v": row[i]["v"], "f": f"{row[i]['v']}+0"}
    out[7] = {"t": "str", "v": call[6], "f": f'IF(1=1,"{call[6]}","")'}
    return out


def shared_formulas_factory():
    seen = {"first": True}

    def transform(row, call):
        out = list(row)
        if seen["first"]:
            out[5] = {"t": None, "v": row[5]["v"], "f": "0+F1*0", "f_attrs": ' t="shared" ref="F2:F49" si="0"'}
            seen["first"] = False
        else:
            out[5] = {"t": None, "v": row[5]["v"], "f": "", "f_attrs": ' t="shared" si="0"'}
        return out
    return transform


def formula_dates_times(row, call):
    day, seconds = call[0], call[1]
    out = _set(row, 1, {"t": None, "v": str(serial_day(day)), "s": STYLE["date"],
                        "f": f"DATE({day.year},{day.month},{day.day})"})
    return _set(out, 2, {"t": None, "v": serial_time(seconds), "s": STYLE["time"],
                         "f": f"TIME({seconds // 3600},{seconds % 3600 // 60},{seconds % 60})"})


def first_only(transform):
    state = {"done": False}

    def t(row, call):
        if state["done"]:
            return row
        state["done"] = True
        return transform(row, call)
    return t


def custom_formats(row, call):
    k = call[1] % 4
    date_style = ["iso_date", "dmy_date", "long_date", "datetime"][k]
    time_style = ["us_time", "system_time", "hmm", "elapsed"][k]
    out = _set(row, 1, {**row[1], "s": STYLE[date_style]})
    return _set(out, 2, {**row[2], "s": STYLE[time_style]})


def text_dates(iso):
    def transform(row, call):
        day, s = call[0], call[1]
        d = day.isoformat() if iso else f"{day.month}/{day.day}/{day.year}"
        clock = f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}"
        return _set(_set(row, 1, text(d)), 2, text(clock))
    return transform


def month_name_dates(row, call):
    return _set(row, 1, text(call[0].strftime("%b %d, %Y")))


def quoted_numbers(row, call):
    out = list(row)
    for i in (3, 4, 5, 6):
        out[i] = {"t": "s", "v": row[i]["v"], "s": STYLE["text"]}
    return out


def date_with_time_part(row, call):
    return _set(row, 1, {"t": None, "v": repr(serial_day(call[0]) + 0.75), "s": STYLE["datetime"]})


def boolean_flags(row, call):
    return _set(row, 7, {"t": "b", "v": "1" if call[6] == "Y" else "0"})


def error_agent(row, call):
    return _set(row, 4, {"t": "e", "v": "#N/A", "f": "NA()"})


def formula_without_value(row, call):
    return _set(row, 4, {"t": None, "v": None, "f": "300+0"})


def rich_header(path):
    b = Book(shared_strings=False)
    head = header_cells(inline=True)
    head[1] = {"t": "inlineStr", "v": "Start_Date", "rich": ["Start_", "Date"]}
    rows = [default_row(c, inline=True) for c in calls()]
    rows[0][7] = {"t": "inlineStr", "v": rows[0][7]["v"], "rich": [rows[0][7]["v"]]}
    b.add_sheet("Sheet1", [head] + rows)
    b.save(path)


def phonetic_strings(path):
    b = Book()
    b.phonetic["Abandon"] = "アバンドン"
    simple(path, book=b)


def layout_case(**opts):
    def write(path):
        b = Book()
        rows = [header_cells()] + [default_row(c) for c in calls()]
        if opts.pop("summary_first", False):
            b.add_sheet("Summary", [[text("Calls Offered"), number(48)]])
        hidden = opts.pop("hidden", None)
        b.add_sheet("Calls", rows, **opts)
        if hidden:
            more = [header_cells()] + [default_row(c) for c in calls(1, 24, date(2026, 11, 12))]
            b.add_sheet("Hidden calls", more, state=hidden)
        if opts.get("frozen"):
            b.add_chart_sheet("Chart1")
        b.save(path)
    return write


def no_refs(path):
    b = Book()
    b.add_sheet("Sheet1", [header_cells()] + [default_row(c) for c in calls()], refs=False)
    b.save(path)


def prefixed(path):
    b = Book(prefix="x:")
    b.add_sheet("Sheet1", [header_cells()] + [default_row(c) for c in calls()])
    b.save(path)


def leading_rows(path):
    b = Book()
    b.add_sheet("Sheet1", [header_cells()] + [default_row(c) for c in calls()], first_row=3)
    b.save(path)


def leading_columns(path):
    b = Book()
    b.add_sheet("Sheet1", [header_cells()] + [default_row(c) for c in calls()], first_col=2)
    b.save(path)


def long_sheet(path, days=550):
    """About 100,000 calls on one sheet (550 days x 182)."""
    b = Book()
    b.add_sheet("Call Records", [header_cells()] + [default_row(c) for c in calls(days, 182, date(2025, 1, 1))],
                frozen=True, autofilter=True)
    b.save(path)


def date1904_book():
    return Book(date1904=True)


def inline_book():
    return Book(shared_strings=False)


CASES = {
    # Excel's usual shape: shared strings, date 14 / time 21, frozen header, filter, chart sheet.
    "xl_excel_shape.xlsx": layout_case(frozen=True, autofilter=True),
    "xl_inline_strings.xlsx": with_cells(lambda r, c: r, book=inline_book),
    "xl_date1904.xlsx": with_cells(lambda r, c: r, book=date1904_book),
    "xl_iso_date_cells.xlsx": with_cells(iso_dates),
    "xl_iso_date_and_time_cells.xlsx": with_cells(iso_date_and_time),
    "xl_formula_durations_cached.xlsx": with_cells(formula_durations),
    "xl_shared_formulas.xlsx": lambda p: with_cells(shared_formulas_factory())(p),
    "xl_formula_dates_times.xlsx": with_cells(formula_dates_times),
    "xl_formula_error_cached.xlsx": with_cells(first_only(error_agent)),
    "xl_formula_without_cached_value.xlsx": with_cells(first_only(formula_without_value)),
    "xl_custom_and_builtin_formats.xlsx": with_cells(custom_formats),
    "xl_text_iso_dates_and_times.xlsx": with_cells(text_dates(iso=True)),
    "xl_text_us_dates_and_times.xlsx": with_cells(text_dates(iso=False)),
    "xl_month_name_text_dates.xlsx": with_cells(month_name_dates),
    "xl_numbers_stored_as_text.xlsx": with_cells(quoted_numbers),
    "xl_date_cell_with_time_part.xlsx": with_cells(date_with_time_part),
    "xl_boolean_abandon.xlsx": with_cells(first_only(boolean_flags)),
    "xl_rich_text_runs.xlsx": rich_header,
    "xl_phonetic_strings.xlsx": phonetic_strings,
    "xl_summary_then_hidden_calls.xlsx": layout_case(summary_first=True, hidden="hidden"),
    "xl_very_hidden_calls.xlsx": layout_case(hidden="veryHidden"),
    "xl_no_cell_references.xlsx": no_refs,
    "xl_prefixed_elements.xlsx": prefixed,
    "xl_empty_leading_rows.xlsx": leading_rows,
    "xl_empty_leading_columns.xlsx": leading_columns,
    "xl_long_sheet.xlsx": long_sheet,
}

if __name__ == "__main__":
    import sys

    folder = Path(sys.argv[1])
    folder.mkdir(parents=True, exist_ok=True)
    for name, write in CASES.items():
        write(folder / name)
        print(name)
