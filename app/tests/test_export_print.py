#!/usr/bin/env python3
"""
Renders the A4 print page, then prints it for real and checks the paper.

src/export/print.ts builds the HTML that the phone's print dialog turns
into paper -- straight to a printer, or into a PDF saved to send on
WhatsApp. Everything that can go wrong there is a layout question no type
checker can see: a heading that does not repeat, an event nobody has
counted printing as "0", a family name with an "&" in it cutting the page
in half, the next event's list starting halfway down the previous one.

The checks run the same writer the app runs (compiled with the project's
tsc, executed under node) and assert on the HTML it produces. When Chrome
and poppler are installed, the page is then actually printed: Chrome is the
same rendering engine as the Android WebView that does the printing, so
"is this A4", "did page two keep its headings" and "does the dash survive"
are checked on a real document instead of argued about.

Run: python3 app/tests/test_export_print.py
"""

import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

from test_export_xlsx import MODEL, run_writer

failures = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        failures.append(label)


def render(workdir, model, name):
    path = run_writer(workdir, "src/export/print.ts", "buildExportHtml", model, name, False)
    return path.read_text()


def long_family(index):
    return {
        "id": f"g{index}",
        "name": f"Family {index:02d} Khan",
        "phone": "03001234567",
        # Recorded zeroes on purpose: 0 men is a statement somebody made,
        # and it has to print as 0 while a dash prints as a dash.
        "men": index % 5,
        "women": None if index % 7 == 0 else index % 4,
    }


def long_model(first=60, second=20):
    """
    Two events, the first far too long for one page.

    The heading repeating is the whole reason `thead` is told to behave as
    a table header group, and it cannot be checked on a three-row page.
    """
    return {
        "generatedAt": MODEL["generatedAt"],
        "familyCount": first + second,
        "groups": [
            {
                "eventId": "ev1",
                "name": "Faiz Baraat",
                "date": "2026-12-11",
                "families": [long_family(index) for index in range(1, first + 1)],
            },
            {
                "eventId": "ev2",
                "name": "Moiz Baraat",
                "date": None,
                "families": [long_family(index) for index in range(first + 1, first + second + 1)],
            },
        ],
    }


def print_real_pages(page_path, out_dir):
    """Chrome's headless print, which is the Android WebView's engine."""
    chrome = shutil.which("google-chrome") or shutil.which("chromium")
    if not chrome:
        return None
    pdf = out_dir / "page.pdf"
    printed = subprocess.run(
        [
            chrome,
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--no-pdf-header-footer",
            f"--print-to-pdf={pdf}",
            "--virtual-time-budget=4000",
            page_path.as_uri(),
        ],
        capture_output=True,
        text=True,
        timeout=240,
    )
    if printed.returncode != 0 or not pdf.exists():
        raise RuntimeError(f"chrome failed:\n{printed.stdout[-500:]}\n{printed.stderr[-500:]}")
    return pdf


def page_text(pdf, first=None, last=None):
    command = ["pdftotext", "-layout"]
    if first is not None:
        command += ["-f", str(first), "-l", str(last or first)]
    text = subprocess.run(
        [*command, str(pdf), "-"], capture_output=True, text=True, timeout=60
    ).stdout
    return text


def main():
    workdir = pathlib.Path(tempfile.mkdtemp(prefix="print-check-"))
    try:
        page = render(workdir, MODEL, "page.html")

        print("\n1. the page is written for A4")
        check("every page is A4 portrait", "@page { size: A4 portrait;" in page)
        check("the heading row repeats on every printed page", "display: table-header-group" in page)
        check("rows are never split across a page break", "page-break-inside: avoid" in page)
        check(
            "each event's list starts a page of its own",
            ".group + .group { page-break-before: always; }" in page,
        )
        check("backgrounds survive print, instead of printing white on white", "print-color-adjust: exact" in page)
        check(
            "the columns keep the widths they were given, whatever the names are",
            "table-layout: fixed" in page
            and 'class="family" style="width: 55%"' in page
            and 'class="count" style="width: 15%"' in page,
        )

        print("\n2. one section per event, and only what belongs to it")
        check(
            "a section per event, in event order, with the leftovers last",
            re.findall(r"<h1>([^<]*)</h1>", page)
            == [group["name"] for group in MODEL["groups"]],
            f"-> {re.findall(r'<h1>([^<]*)</h1>', page)}",
        )
        check(
            "one table per event, not one table with everyone in it",
            page.count("<table>") == len(MODEL["groups"]),
            f"-> {page.count('<table>')} tables",
        )
        check(
            "a row per family on that event's list, plus that list's totals row",
            page.count('<td class="family">')
            == sum(len(group["families"]) for group in MODEL["groups"]) + 4,
            f"-> {page.count('<td class=\"family\">')} family cells",
        )
        check(
            "the first event's totals are its own numbers, the ones the chip shows",
            '<tr class="total"><td class="family">TOTAL</td>'
            '<td class="count">4</td><td class="count">2</td><td class="count">6</td></tr>' in page,
        )
        check(
            "the second event's totals are its own, and not the first event's",
            '<tr class="total"><td class="family">TOTAL</td>'
            '<td class="count">3</td><td class="count">2</td><td class="count">5</td></tr>' in page,
        )
        check(
            "a family on two lists keeps its own row on each, counts and all",
            page.count('<td class="family">Raza &amp; Sons &lt;Mumtaz&gt;</td>') == 2,
        )
        check(
            "an uncounted side prints as the app's dash, and the other side still counts",
            '<td class="count">1</td><td class="count">—</td><td class="count">1</td>' in page,
        )

        print("\n3. an event nobody has counted says nothing, rather than zero")
        check(
            "an empty list says so instead of printing a page of headings",
            '<td class="empty" colspan="4">No families yet</td>' in page,
        )
        check(
            "an empty list gets no totals row to be misread",
            page.count('<tr class="total">') == 4,
            f"-> {page.count('<tr class=\"total\">')} totals rows",
        )
        check(
            "a family nobody has counted shows a dash in every count column",
            '<td class="family">Nadia</td>'
            '<td class="count">—</td><td class="count">—</td><td class="count">—</td>' in page,
        )
        check(
            "that list's totals are dashes too, never a row of zeroes",
            '<tr class="total"><td class="family">TOTAL</td>'
            '<td class="count">—</td><td class="count">—</td><td class="count">—</td></tr>' in page,
        )
        check(
            "a row is the family and its three counts, and nothing else",
            '<td class="family">Bano</td><td class="count">1</td>'
            '<td class="count">—</td><td class="count">1</td></tr>' in page,
        )

        print("\n4. the page says the event and the count, and nothing else")
        check(
            "each list is headed by its event and its date",
            '<h1>Faiz Baraat</h1>\n  <p class="meta">' in page and "2026" in page,
        )
        check(
            "an event with no date is headed by its name and count alone",
            '<h1>Moiz Baraat</h1>\n  <p class="meta">1 family</p>' in page,
        )
        check(
            "the leftovers list says how many are waiting for an event",
            '<h1>No event yet</h1>\n  <p class="meta">1 family</p>' in page,
        )
        check(
            "no card, union, or rollup line survives on the page",
            not re.search(r"card|pending|union|in total|rollup|counted once|across all", page, re.IGNORECASE),
            f"-> {re.findall(r'[^<>]*(?:card|union|rollup)[^<>]*', page, re.IGNORECASE)[:3]}",
        )
        check(
            "there is no notes block to read, only the numbers",
            "class=\"notes\"" not in page and "class=\"summary\"" not in page,
        )
        check(
            "no phone number and no phone column reach the paper",
            "03001234567" not in page and "03007654321" not in page and "Phone" not in page,
        )
        check(
            "&, < and > are escaped, so a name cannot break the page",
            "Raza &amp; Sons &lt;Mumtaz&gt;" in page and "<Mumtaz>" not in page,
        )

        print("\n5. printing it for real (Chrome, the WebView's engine)")
        checkers = [shutil.which("pdfinfo"), shutil.which("pdftotext")]
        if not shutil.which("google-chrome") or not all(checkers):
            print("  skip  Chrome and poppler are needed for this (pdfinfo, pdftotext)")
        else:
            big = render(workdir, long_model(), "long.html")
            pdf = print_real_pages(workdir / "long.html", workdir)

            info = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True, timeout=60).stdout
            pages = int(re.search(r"Pages:\s+(\d+)", info).group(1))
            size = re.search(r"Page size:\s*([\d.]+) x ([\d.]+)", info)
            width, height = (float(value) for value in size.groups())
            check("80 families run onto more than one page", pages >= 3, f"-> {pages} pages")
            check(
                "the paper really is A4 portrait (595.3 x 841.9 pt)",
                abs(width - 595.3) <= 1.5 and abs(height - 841.9) <= 1.5,
                f"-> {width} x {height} pt",
            )

            first = page_text(pdf, 1)
            spill = page_text(pdf, 2)
            last = page_text(pdf, pages)
            check(
                "the first page is the first event's list",
                "Family 01 Khan" in first and "Moiz Baraat" not in first,
            )
            check(
                "a list that runs over keeps its heading row on the next page",
                "Family" in spill and "Women" in spill,
                f"-> {spill.strip().splitlines()[:2]}",
            )
            check(
                "the next event starts a page of its own, not the tail of the last one",
                "Moiz Baraat" in last and "Moiz Baraat" not in spill,
                f"-> last page: {last.strip().splitlines()[:2]}",
            )
            check("the last family is on the paper, not cut off", "Family 80 Khan" in last)
            check("the dash survives into the printed PDF", "—" in page_text(pdf, 1, pages))
            check(
                "the long model is what got printed",
                big.count('<td class="family">') == 60 + 20 + 2,
                f"-> {big.count('<td class=\"family\">')} family cells",
            )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
    print()
    if failures:
        print(f"FAILED: {len(failures)} check(s)")
        sys.exit(1)
    print("all print checks passed")
