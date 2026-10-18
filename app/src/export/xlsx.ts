import { strToU8, zipSync } from 'fflate';

import {
  countCell,
  familyTotal,
  groupCounts,
  type ExportGroup,
  type ExportModel,
} from './model';

interface SheetSpec {
  name: string;
  widths: number[];
  centred: number[];
  boldRows: number[];
  rows: (string | number | null)[][];
}

const STYLE_PLAIN = 0;
const STYLE_HEADER = 1;
const STYLE_CENTRED = 2;
const STYLE_BOLD = 3;
const STYLE_BOLD_CENTRED = 4;

const COLUMNS = ['Family', 'Men', 'Women', 'Total'];
const WIDTHS = [34, 8, 9, 9];
const CENTRED = [1, 2, 3];

export function buildExportXlsx(model: ExportModel): Uint8Array {
  const sheets = sheetSpecs(model);

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypesXml(sheets.length)),
    '_rels/.rels': strToU8(ROOT_RELS_XML),
    'xl/workbook.xml': strToU8(workbookXml(sheets.map((sheet) => sheet.name))),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRelsXml(sheets.length)),
    'xl/styles.xml': strToU8(STYLES_XML),
  };
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(sheetXml(sheet));
  });

  return zipSync(files);
}

function sheetSpecs(model: ExportModel): SheetSpec[] {
  if (model.groups.length === 0) {
    return [{ name: 'Families', widths: WIDTHS, centred: CENTRED, boldRows: [], rows: [COLUMNS] }];
  }

  const taken = new Set<string>([HISTORY_SHEET.toLowerCase()]);
  return model.groups.map((group) => groupSheet(group, sheetName(group.name, taken)));
}

function groupSheet(group: ExportGroup, name: string): SheetSpec {
  const rows: (string | number | null)[][] = [COLUMNS];

  for (const family of group.families) {
    rows.push([
      family.name,
      countCell(family.men),
      countCell(family.women),
      countCell(familyTotal(family)),
    ]);
  }

  const boldRows: number[] = [];
  if (group.families.length === 0) {
    rows.push(['No families yet']);
  } else {
    const counts = groupCounts(group);
    boldRows.push(rows.length);
    rows.push(['TOTAL', countCell(counts.men), countCell(counts.women), countCell(counts.total)]);
  }

  const widestName = group.families.reduce(
    (widest, family) => Math.max(widest, family.name.length),
    24
  );

  return {
    name,
    widths: [Math.min(40, widestName + 2), ...WIDTHS.slice(1)],
    centred: CENTRED,
    boldRows,
    rows,
  };
}

const HISTORY_SHEET = 'History';

function sheetName(raw: string, taken: Set<string>): string {
  const cleaned = raw.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'List';

  let candidate = cleaned;
  let attempt = 2;
  while (taken.has(candidate.toLowerCase())) {
    const suffix = ` (${attempt++})`;
    candidate = cleaned.slice(0, 31 - suffix.length) + suffix;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

function sheetXml(sheet: SheetSpec): string {
  const cols = sheet.widths
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
    .join('');

  const rows = sheet.rows
    .map((cells, row) => {
      const height = row === 0 ? ' ht="26" customHeight="1"' : '';
      const rendered = cells
        .map((value, column) => cellXml(`${columnName(column)}${row + 1}`, value, styleFor(sheet, row, column)))
        .join('');
      return `<row r="${row + 1}"${height}>${rendered}</row>`;
    })
    .join('');

  const lastCell = `${columnName(sheet.widths.length - 1)}${Math.max(sheet.rows.length, 1)}`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<dimension ref="A1:${lastCell}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${rows}</sheetData>
<printOptions horizontalCentered="1"/>
<pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>
<headerFooter><oddFooter>&amp;LGenerated &amp;D &amp;T&amp;RPage &amp;P of &amp;N</oddFooter></headerFooter>
</worksheet>`;
}

function styleFor(sheet: SheetSpec, row: number, column: number): number {
  if (row === 0) return STYLE_HEADER;
  const bold = sheet.boldRows.includes(row);
  const centred = sheet.centred.includes(column);
  if (bold) return centred ? STYLE_BOLD_CENTRED : STYLE_BOLD;
  return centred ? STYLE_CENTRED : STYLE_PLAIN;
}

function cellXml(ref: string, value: string | number | null, style: number): string {
  if (value === null || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  }
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
}

function columnName(index: number): string {
  let name = '';
  let remaining = index + 1;
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return name;
}

function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function contentTypesXml(sheets: number): string {
  const worksheetOverrides = Array.from(
    { length: sheets },
    (_, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${worksheetOverrides}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
}

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

function workbookRelsXml(sheets: number): string {
  const sheetRels = Array.from(
    { length: sheets },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheetRels}
<Relationship Id="rId${sheets + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function workbookXml(sheetNames: string[]): string {
  const sheets = sheetNames
    .map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('');

  const titles = sheetNames
    .map(
      (name, index) =>
        `<definedName name="_xlnm.Print_Titles" localSheetId="${index}">${escapeXml(`'${name.replace(/'/g, "''")}'!$1:$1`)}</definedName>`
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<workbookPr/>
<sheets>${sheets}</sheets>
<definedNames>${titles}</definedNames>
</workbook>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2">
<font><sz val="11"/><color rgb="FF14141A"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FF14141A"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF6E9ED"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FF7B2D43"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
