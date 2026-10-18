#!/usr/bin/env python3
"""
Builds the export spreadsheet for real, then checks it part by part.

src/export/xlsx.ts assembles the OOXML by hand rather than leaning on a
spreadsheet library, because the one thing this file has to get right --
printing on A4 with the heading repeated and the columns fitted to one
page -- lives in elements that libraries either cannot express or express
differently. The cost is that one malformed part turns the whole file into
"Excel cannot open Wedding-families.xlsx" with no detail at all, and that
failure would only ever show up in a family member's hands.

So the writer is compiled with the project's own tsc, run under node
against fixed models, and the file it produces is opened with Python's
zipfile and ElementTree:

  * one sheet per event, in the app's event order, named after the event,
    with the families no event has claimed on a last sheet of their own
  * Excel's rules about sheet names obeyed -- 31 characters, no []:*?/\\,
    not "History", no two the same -- including the collisions a family
    would never think to avoid
  * each sheet is that event's families and their men, women and total
    counts, and nothing else: no card columns, no phone numbers, no notes,
    no union row
  * counts are numbers (so Excel can sort and sum them), "not recorded"
    is the dash, and a list nobody has counted says nothing rather than
    claiming nobody is coming
  * a sheet's totals are the numbers the app shows on that event's chip,
    so the sheet and the phone agree line for line
  * page setup is A4 (paperSize 9), one page wide, row 1 repeated on every
    printed page
  * a name containing &, < and > survives as text

Run: python3 app/tests/test_export_xlsx.py
"""

import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile

APP = pathlib.Path(__file__).resolve().parents[1]

MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
PKG = "{http://schemas.openxmlformats.org/package/2006/relationships}"
CT = "{http://schemas.openxmlformats.org/package/2006/content-types}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

failures = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        failures.append(label)


# The cases the app exists to keep straight, all in one small model:
#   * Raza comes to two events, so he is on two lists -- and on neither
#     list counted twice
#   * Bano's women's side was never recorded: the dash, while the men's
#     side still counts and still adds up
#   * Mehndi has nobody on it yet
#   * Walima is the harder case: nobody has counted Nadia at all, so no
#     part of that sheet may print a 0
#   * Nusrat is on the family list and invited nowhere, so she gets the
#     leftover sheet
# The fixtures carry phone numbers the export must not print: the writer's
# job now is to leave them out, and only a model that has them can catch
# that being undone.
MODEL = {
    "generatedAt": "2026-10-17T09:30:00.000Z",
    "familyCount": 4,
    "groups": [
        {
            "eventId": "ev1",
            "name": "Faiz Baraat",
            "date": "2026-12-11",
            "families": [
                {"id": "g1", "name": "Raza & Sons <Mumtaz>", "phone": "03001234567", "men": 3, "women": 2},
                {"id": "g2", "name": "Bano", "phone": None, "men": 1, "women": None},
            ],
        },
        {
            "eventId": "ev2",
            "name": "Moiz Baraat",
            "date": None,
            "families": [
                {"id": "g1", "name": "Raza & Sons <Mumtaz>", "phone": "03001234567", "men": 3, "women": 2},
            ],
        },
        {"eventId": "ev3", "name": "Mehndi", "date": "2026-12-12", "families": []},
        {
            "eventId": "ev4",
            "name": "Walima",
            "date": "2026-12-13",
            "families": [
                {"id": "g4", "name": "Nadia", "phone": "03007654321", "men": None, "women": None},
            ],
        },
        {
            "eventId": None,
            "name": "No event yet",
            "date": None,
            "families": [
                {"id": "g3", "name": "Nusrat", "phone": None, "men": 2, "women": 1},
            ],
        },
    ],
}

SHEET_NAMES = ["Faiz Baraat", "Moiz Baraat", "Mehndi", "Walima", "No event yet"]

# What the six sheets above are called once Excel's rules have had their
# way: two names that differ only in characters a sheet name cannot hold,
# two that differ only past the 31st character, a reserved word, and a
# name full of characters that have to be escaped in the XML but are
# perfectly legal on a tab.
NAMES_MODEL = {
    "generatedAt": MODEL["generatedAt"],
    "familyCount": 0,
    "groups": [
        {"eventId": "n1", "name": "Rukhsati / dinner", "date": None, "families": []},
        {"eventId": "n2", "name": "Rukhsati : dinner", "date": None, "families": []},
        {"eventId": "n3", "name": "A" * 40, "date": None, "families": []},
        {"eventId": "n4", "name": "A" * 39 + "B", "date": None, "families": []},
        {"eventId": "n5", "name": "History", "date": None, "families": []},
        {"eventId": "n6", "name": "Haldi & Mehndi <night>", "date": None, "families": []},
    ],
}

NAMES_SHEETS = [
    "Rukhsati dinner",
    "Rukhsati dinner (2)",
    "A" * 31,
    "A" * 27 + " (2)",
    "History (2)",
    "Haldi & Mehndi <night>",
]


def run_writer(workdir, entry, builder, model, output_name, binary):
    """
    Compiles one of the export writers with the project's tsc and runs it
    under node against `model`.

    The build lands in the system temp directory, with NODE_PATH pointing
    at the app's own node_modules: the check runs offline, against the exact
    dependency the app bundles, and leaves nothing behind in the repo even
    if it crashes halfway.
    """
    tsc = APP / "node_modules" / ".bin" / "tsc"
    compiler = [str(tsc)] if tsc.exists() else ["npx", "tsc"]
    built = subprocess.run(
        compiler
        + [
            # Compile just this file, with just these flags: the project's
            # tsconfig is for the app bundle (Babel does that work anyway),
            # and tsc 6 refuses to mix the two.
            "--ignoreConfig",
            str(APP / entry),
            "--outDir",
            str(workdir / "js"),
            "--module",
            "commonjs",
            "--target",
            "es2022",
            "--moduleResolution",
            "node",
            "--ignoreDeprecations",
            "6.0",
            "--skipLibCheck",
        ],
        cwd=APP,
        capture_output=True,
        text=True,
    )
    if built.returncode != 0:
        raise RuntimeError(f"tsc failed:\n{built.stdout}\n{built.stderr}")

    produced = list((workdir / "js").rglob(pathlib.Path(entry).with_suffix(".js").name))
    if not produced:
        raise RuntimeError(f"tsc produced no {entry}")

    model_file = workdir / f"{output_name}.json"
    model_file.write_text(json.dumps(model))
    out_file = workdir / output_name

    script = (
        "const fs = require('fs');"
        "const writer = require(process.env.WRITER_MODULE);"
        "const model = JSON.parse(fs.readFileSync(process.env.WRITER_MODEL, 'utf8'));"
        "const value = writer[process.env.WRITER_FUNCTION](model);"
        "const out = process.env.WRITER_BINARY === '1' ? Buffer.from(value) : value;"
        "fs.writeFileSync(process.env.WRITER_OUT, out);"
    )
    ran = subprocess.run(
        ["node", "-e", script],
        cwd=APP,
        capture_output=True,
        text=True,
        env={
            **os.environ,
            "NODE_PATH": str(APP / "node_modules"),
            "WRITER_MODULE": str(produced[0]),
            "WRITER_MODEL": str(model_file),
            "WRITER_OUT": str(out_file),
            "WRITER_FUNCTION": builder,
            "WRITER_BINARY": "1" if binary else "0",
        },
    )
    if ran.returncode != 0:
        raise RuntimeError(f"node failed:\n{ran.stdout}\n{ran.stderr}")

    return out_file


def build(workdir, model, name="sample.xlsx"):
    return run_writer(workdir, "src/export/xlsx.ts", "buildExportXlsx", model, name, True)


def read_cells(sheet_root):
    """
    Refs -> {text, numeric, style}, the way a spreadsheet reader sees them.

    Empty cells are absent, which is the point: a skipped cell is how the
    writer says "nothing here", and the checks below distinguish that from
    a cell holding text.

    A cell whose column letter is past E is the failure mode this guards
    against -- the card columns this file used to have.
    """
    cells = {}
    for cell in sheet_root.iter(MAIN + "c"):
        kind = cell.get("t")
        if kind == "inlineStr":
            node = cell.find(f"{MAIN}is/{MAIN}t")
            text = (node.text or "") if node is not None else ""
        else:
            node = cell.find(MAIN + "v")
            text = node.text if node is not None else ""
        cells[cell.get("r")] = {
            "text": text,
            "numeric": kind is None,
            "inline": kind == "inlineStr",
            "style": cell.get("s"),
        }
    return cells


def sheet_rows(sheet_root):
    return sheet_root.findall(f"{MAIN}sheetData/{MAIN}row")


def texts(cells):
    """Every text cell on a sheet, in row order -- what a reader would read."""
    return [cells[ref]["text"] for ref in sorted(cells, key=row_order) if cells[ref]["inline"]]


def row_order(ref):
    match = re.match(r"([A-Z]+)(\d+)", ref)
    return (int(match.group(2)), match.group(1))


def check_names_workbook(workdir):
    """The sheet-name rules, on a workbook of names nobody would design."""
    print("\n2. hostile event names still make a workbook Excel opens")
    names_file = build(workdir, NAMES_MODEL, "names.xlsx")
    archive = zipfile.ZipFile(names_file)
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    sheets = workbook.findall(f"{MAIN}sheets/{MAIN}sheet")
    got = [sheet.get("name") for sheet in sheets]

    check(
        "sheet names are cut to fit, cleaned, made unique, and never blank",
        got == NAMES_SHEETS,
        f"-> {got}",
    )
    check(
        "no sheet name could be refused by Excel",
        all(len(name) <= 31 and not set("[]:*?/\\") & set(name) for name in got),
        f"-> {got}",
    )
    raw = archive.read("xl/workbook.xml").decode()
    check(
        "a & or < in an event name is escaped in the workbook",
        "Haldi &amp; Mehndi &lt;night&gt;" in raw and "<night>" not in raw,
    )
    titles = [
        node.text
        for node in workbook.findall(f"{MAIN}definedNames/{MAIN}definedName")
        if node.get("name") == "_xlnm.Print_Titles"
    ]
    check(
        "print titles are per sheet and quoted, so a name with spaces works",
        titles
        == [f"'{name}'!$1:$1" for name in NAMES_SHEETS],
        f"-> {titles}",
    )


def check_with_libreoffice(sample):
    """
    Opens the file in a real spreadsheet application, when one is here.

    ElementTree can only say that the XML is well-formed. A program that
    has to lay the sheet out, paginate it and honour the page setup is the
    closest thing to Excel that runs on this machine, and the page boxes it
    produces are the actual answer to "will this print on A4".

    Skipped, loudly, when LibreOffice is not installed -- the rest of this
    file stands on its own.
    """
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        print("\n8. opening it in a real spreadsheet app")
        print("  skip  LibreOffice is not installed")
        return

    print("\n8. opening it in a real spreadsheet app")
    out = pathlib.Path(tempfile.mkdtemp(prefix="xlsx-open-"))
    try:
        profile = out / "profile"
        csv_filter = (
            "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true,false,false,0"
        )
        opened = subprocess.run(
            [
                soffice,
                "--headless",
                "--norestore",
                f"-env:UserInstallation={profile.as_uri()}",
                "--convert-to",
                csv_filter,
                "--outdir",
                str(out),
                str(sample),
            ],
            capture_output=True,
            text=True,
            timeout=240,
        )
        csv_file = out / "sample.csv"
        check(
            "LibreOffice opens the workbook",
            opened.returncode == 0 and csv_file.exists(),
            f"-> {opened.stderr[-200:]!r}",
        )
        if csv_file.exists():
            text = csv_file.read_text()
            check(
                "a real reader opens on the first event's list, family and counts together",
                "Raza & Sons <Mumtaz>,3,2,5" in text,
                f"-> {text.splitlines()[:3]}",
            )
            check(
                "the dash and the event's own total survive into a real reader",
                "Bano,1,—,1" in text and "TOTAL,4,2,6" in text,
                f"-> {text.splitlines()[:3]}",
            )
            check(
                "no card column and no phone column ever reaches the reader",
                "Card" not in text and "Pending" not in text and "Phone" not in text and "03001" not in text,
            )

        made = subprocess.run(
            [
                soffice,
                "--headless",
                "--norestore",
                f"-env:UserInstallation={profile.as_uri()}",
                "--convert-to",
                "pdf",
                "--outdir",
                str(out),
                str(sample),
            ],
            capture_output=True,
            text=True,
            timeout=240,
        )
        pdf = out / "sample.pdf"
        if made.returncode == 0 and pdf.exists():
            boxes = {
                tuple(round(float(value), 1) for value in match.split())
                for match in re.findall(rb"/MediaBox\s*\[([^\]]+)\]", pdf.read_bytes())
            }
            # A4 is 595.3 x 841.9 points, and a five-column list is portrait.
            check(
                "every sheet pages up as A4 portrait",
                boxes == {(0.0, 0.0, 595.3, 841.9)},
                f"-> {sorted(boxes)}",
            )
        else:
            check("LibreOffice renders a PDF", False, f"-> {made.stderr[-200:]!r}")
    except subprocess.SubprocessError as error:
        print(f"  skip  real-reader checks ({type(error).__name__}: LibreOffice did not finish)")
    finally:
        shutil.rmtree(out, ignore_errors=True)


def main():
    workdir = pathlib.Path(tempfile.mkdtemp(prefix="xlsx-check-"))
    try:
        sample = build(workdir, MODEL)

        print("\n1. the file is a valid package")
        check("sample was built", sample.exists() and sample.stat().st_size > 0)
        archive = zipfile.ZipFile(sample)
        names = set(archive.namelist())
        required = {
            "[Content_Types].xml",
            "_rels/.rels",
            "xl/workbook.xml",
            "xl/_rels/workbook.xml.rels",
            "xl/styles.xml",
        } | {f"xl/worksheets/sheet{index}.xml" for index in range(1, len(SHEET_NAMES) + 1)}
        check("every required part is present", required <= names, f"-> missing {required - names}")

        parts = {name: archive.read(name) for name in sorted(names)}
        roots = {}
        for name, payload in parts.items():
            try:
                roots[name] = ET.fromstring(payload)
            except ET.ParseError as error:
                check(f"{name} parses", False, f"-> {error}")
        check("every part is well-formed XML", len(roots) == len(parts), f"-> {len(roots)}/{len(parts)}")

        content_types = roots["[Content_Types].xml"]
        overrides = {node.get("PartName") for node in content_types.findall(CT + "Override")}
        worksheets = [f"xl/worksheets/sheet{index}.xml" for index in range(1, len(SHEET_NAMES) + 1)]
        for part in ["xl/workbook.xml", "xl/styles.xml", *worksheets]:
            check(f"content types declare {part}", f"/{part}" in overrides)
        check(
            "no content type points at a missing part",
            all(part.lstrip("/") in names for part in overrides),
            f"-> {[p for p in overrides if p.lstrip('/') not in names]}",
        )

        workbook = roots["xl/workbook.xml"]
        sheets = workbook.findall(f"{MAIN}sheets/{MAIN}sheet")
        check(
            "one sheet per event, in event order, then the families with no event",
            [sheet.get("name") for sheet in sheets] == SHEET_NAMES,
            f"-> {[s.get('name') for s in sheets]}",
        )

        rels = roots["xl/_rels/workbook.xml.rels"]
        by_id = {rel.get("Id"): rel.get("Target") for rel in rels.findall(PKG + "Relationship")}
        sheet_targets = [by_id.get(sheet.get(REL + "id")) for sheet in sheets]
        check(
            "each sheet's relationship points at its own worksheet",
            sheet_targets == [f"worksheets/sheet{index}.xml" for index in range(1, len(SHEET_NAMES) + 1)],
            f"-> {sheet_targets}",
        )
        check(
            "all worksheet targets exist in the package",
            all(target and f"xl/{target}" in names for target in sheet_targets),
            f"-> {sheet_targets}",
        )

        check_names_workbook(workdir)

        print("\n3. a phone with nothing on it still writes a file Excel opens")
        empty_file = build(
            workdir,
            {"generatedAt": MODEL["generatedAt"], "familyCount": 0, "groups": []},
            "empty.xlsx",
        )
        empty_archive = zipfile.ZipFile(empty_file)
        empty_book = ET.fromstring(empty_archive.read("xl/workbook.xml"))
        empty_sheets = empty_book.findall(f"{MAIN}sheets/{MAIN}sheet")
        check(
            "an empty export is still one sheet with the headings, not a sheetless file",
            [sheet.get("name") for sheet in empty_sheets] == ["Families"]
            and "xl/worksheets/sheet1.xml" in empty_archive.namelist(),
            f"-> {[sheet.get('name') for sheet in empty_sheets]}",
        )

        print("\n4. print setup is A4 portrait, one page wide, heading repeated")
        elements = []
        for index, sheet_name in enumerate(SHEET_NAMES, start=1):
            sheet = roots[f"xl/worksheets/sheet{index}.xml"]
            page_setup = sheet.find(MAIN + "pageSetup")
            check(
                f"'{sheet_name}' is A4 (paperSize 9) portrait, fitted to one page wide",
                page_setup.get("paperSize") == "9"
                and page_setup.get("orientation") == "portrait"
                and page_setup.get("fitToWidth") == "1"
                and page_setup.get("fitToHeight") == "0",
                f"-> {page_setup.attrib}",
            )
            page_pr = sheet.find(f"{MAIN}sheetPr/{MAIN}pageSetUpPr")
            check(
                f"'{sheet_name}' has fitting switched on",
                page_pr is not None and page_pr.get("fitToPage") == "1",
            )
            footer = sheet.find(f"{MAIN}headerFooter/{MAIN}oddFooter")
            check(
                f"'{sheet_name}' numbers its printed pages in the footer",
                footer is not None and "&P of &N" in (footer.text or ""),
            )
            pane = sheet.find(f"{MAIN}sheetViews/{MAIN}sheetView/{MAIN}pane")
            check(
                f"'{sheet_name}' freezes its heading row on screen",
                pane is not None and pane.get("state") == "frozen" and pane.get("ySplit") == "1",
            )
            cols = sheet.findall(f"{MAIN}cols/{MAIN}col")
            check(
                f"'{sheet_name}' sets its column widths, so nothing prints as ####",
                len(cols) == 4 and all(float(col.get("width")) >= 7 for col in cols),
                f"-> {[col.get('width') for col in cols]}",
            )
            elements.append([node.tag.split("}")[-1] for node in list(sheet)])

        check(
            "the OOXML element order a reader expects is respected",
            all(
                order
                == [
                    "sheetPr",
                    "dimension",
                    "sheetViews",
                    "sheetFormatPr",
                    "cols",
                    "sheetData",
                    "printOptions",
                    "pageMargins",
                    "pageSetup",
                    "headerFooter",
                ]
                for order in elements
            ),
            f"-> {elements[0]}",
        )

        titles = [
            node.text
            for node in workbook.findall(f"{MAIN}definedNames/{MAIN}definedName")
            if node.get("name") == "_xlnm.Print_Titles"
        ]
        check(
            "row 1 repeats as the print title on every sheet, quoted for the spaces",
            titles == [f"'{name}'!$1:$1" for name in SHEET_NAMES],
            f"-> {titles}",
        )

        print("\n5. each sheet is one event's list, and nothing else")
        sheet_roots = {
            name: roots[f"xl/worksheets/sheet{index}.xml"]
            for index, name in enumerate(SHEET_NAMES, start=1)
        }
        cells = {name: read_cells(root) for name, root in sheet_roots.items()}

        faiz = cells["Faiz Baraat"]
        check(
            "the heading names four columns and stops there",
            [faiz[f"{column}1"]["text"] for column in "ABCD"] == ["Family", "Men", "Women", "Total"]
            and "E1" not in faiz,
            f"-> {[faiz[key]['text'] for key in sorted(faiz) if key.endswith('1')]}",
        )
        check("the heading row uses the header style", faiz["A1"]["style"] == "1", f"-> s={faiz['A1']['style']}")
        check(
            "&, < and > survive in a family name",
            faiz["A2"]["text"] == "Raza & Sons <Mumtaz>",
            f"-> {faiz['A2']['text']!r}",
        )
        check(
            "counts are written as numbers, not text, so Excel can sum them",
            faiz["B2"]["numeric"] and faiz["C2"]["numeric"] and faiz["D2"]["numeric"],
            f"-> B2 numeric={faiz['B2']['numeric']} inline={faiz['B2']['inline']}",
        )
        check("men + women are summed into the row total", faiz["D2"]["text"] == "5" and faiz["D2"]["numeric"])
        check(
            "an uncounted side prints as the dash the app uses, and the other side still counts",
            faiz["B3"]["text"] == "1"
            and faiz["C3"]["text"] == "—"
            and faiz["D3"]["text"] == "1"
            and not faiz["C3"]["numeric"],
            f"-> {faiz['B3']['text']!r} {faiz['C3']['text']!r} {faiz['D3']['text']!r}",
        )
        check(
            "the totals row is that event's own numbers, the ones the chip shows",
            faiz["A4"]["text"] == "TOTAL"
            and [faiz[key]["text"] for key in ("B4", "C4", "D4")] == ["4", "2", "6"],
            f"-> {[faiz[key]['text'] for key in ('A4', 'B4', 'C4', 'D4')]}",
        )
        check(
            "the totals row is bold, label and numbers alike",
            faiz["A4"]["style"] == "3" and faiz["B4"]["style"] == "4",
            f"-> A4 s={faiz['A4']['style']} B4 s={faiz['B4']['style']}",
        )
        check(
            "the first event's sheet is its heading, its families with counts, and its total",
            texts(faiz)
            == [
                "Family", "Men", "Women", "Total",
                "Raza & Sons <Mumtaz>", "Bano", "—", "TOTAL",
            ],
            f"-> {texts(faiz)}",
        )
        check(
            "the first event is its own sheet, families and totals only",
            len(sheet_rows(sheet_roots["Faiz Baraat"])) == 4,
            f"-> {len(sheet_rows(sheet_roots['Faiz Baraat']))} rows",
        )

        moiz = cells["Moiz Baraat"]
        check(
            "the second event has its own, smaller list and its own totals",
            texts(moiz) == ["Family", "Men", "Women", "Total", "Raza & Sons <Mumtaz>", "TOTAL"]
            and [moiz[key]["text"] for key in ("B3", "C3", "D3")] == ["3", "2", "5"],
            f"-> {texts(moiz)}",
        )
        check(
            "a family coming to two events is on both lists, never as a duplicate row",
            len(sheet_rows(sheet_roots["Moiz Baraat"])) == 3,
            f"-> {len(sheet_rows(sheet_roots['Moiz Baraat']))} rows",
        )

        check(
            "an event nobody is on yet says so, with no fabricated totals row",
            texts(cells["Mehndi"]) == ["Family", "Men", "Women", "Total", "No families yet"],
            f"-> {texts(cells['Mehndi'])}",
        )

        walima = cells["Walima"]
        check(
            "a family nobody has counted shows a dash in every count column",
            [walima[key]["text"] for key in ("B2", "C2", "D2")] == ["—", "—", "—"],
            f"-> {[walima[key]['text'] for key in ('B2', 'C2', 'D2')]}",
        )
        check(
            "an event nobody has counted totals to dashes, not to a row of zeroes",
            [walima[key]["text"] for key in ("B3", "C3", "D3")] == ["—", "—", "—"],
            f"-> {[walima[key]['text'] for key in ('B3', 'C3', 'D3')]}",
        )

        leftovers = cells["No event yet"]
        check(
            "the families no event has claimed get a sheet of their own, totals and all",
            [leftovers[key]["text"] for key in ("A2", "B2", "C2", "D2", "A3", "D3")]
            == ["Nusrat", "2", "1", "3", "TOTAL", "3"],
            f"-> {[leftovers[key]['text'] for key in ('A2', 'B2', 'C2', 'D2', 'A3', 'D3')]}",
        )

        print("\n6. nothing is printed that was not asked for")
        spoken = [text for sheet in cells.values() for text in texts(sheet)]
        check(
            "no sheet mentions cards any more",
            not any(re.search(r"card|pending|sent", text, re.IGNORECASE) for text in spoken),
            f"-> {[t for t in spoken if re.search(r'card|pending|sent', t, re.IGNORECASE)]}",
        )
        check(
            "no sheet argues about unions, or explains what the dash means",
            not any(
                re.search(r"union|not a zero|rollup|across all|generated|weddingSync", text, re.IGNORECASE)
                for text in spoken
            ),
            f"-> {[t for t in spoken if re.search(r'union|zero|rollup|generated', t, re.IGNORECASE)]}",
        )
        check(
            "no phone number reaches any sheet, phone column or not",
            not any(re.fullmatch(r"\d{7,}", text.replace(" ", "")) for text in spoken)
            and all(archive.read(name).find(b"03001234567") == -1 for name in names),
            f"-> {[t for t in spoken if re.search(r'\\d{7,}', t)]}",
        )
        check(
            "no cell sits past column D on any sheet",
            all(
                re.fullmatch(r"[A-D][1-9]\d*", ref)
                for sheet in cells.values()
                for ref in sheet
            ),
            f"-> {[ref for sheet in cells.values() for ref in sheet if not re.fullmatch(r'[A-D][1-9]\\d*', ref)]}",
        )

        print("\n7. the styles the sheets point at exist")
        styles = roots["xl/styles.xml"]
        fonts = styles.find(f"{MAIN}fonts")
        cell_xfs = styles.find(f"{MAIN}cellXfs")
        check(
            "a bold font exists for the heading and totals",
            len(fonts) == 2 and fonts[1].find(MAIN + "b") is not None,
        )
        check(
            "every style index a cell uses is defined",
            len(cell_xfs) == 5
            and all(int(cell["style"]) < 5 for sheet in cells.values() for cell in sheet.values()),
            f"-> cellXfs={len(cell_xfs)}",
        )
        check(
            "fills follow the OOXML convention (none, gray125, then the real ones)",
            [fill.find(MAIN + "patternFill").get("patternType") for fill in styles.find(f"{MAIN}fills")][:2]
            == ["none", "gray125"],
        )

        check_with_libreoffice(sample)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
    print()
    if failures:
        print(f"FAILED: {len(failures)} check(s)")
        sys.exit(1)
    print("all export checks passed")
