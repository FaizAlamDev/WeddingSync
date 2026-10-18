import {
  countCell,
  familyTotal,
  formatExportDay,
  groupCounts,
  plural,
  type ExportGroup,
  type ExportModel,
} from './model';

export function buildExportHtml(model: ExportModel): string {
  const sections = model.groups.map(renderGroup).join('\n');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>Wedding family lists</title>
<style>
  @page { size: A4 portrait; margin: 12mm 10mm; }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 9pt;
    color: #14141A;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .group + .group { page-break-before: always; }

  h1 { font-size: 15pt; margin: 0 0 1mm; color: #7B2D43; }
  .meta { font-size: 9pt; color: #5A5A66; margin: 0 0 3mm; }

  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th {
    background: #F6E9ED;
    color: #5E1F31;
    font-size: 8.5pt;
    text-align: left;
    padding: 1.6mm 2mm;
    border-bottom: 0.75pt solid #7B2D43;
  }
  td {
    padding: 1.4mm 2mm;
    border-bottom: 0.4pt solid #D8D8DE;
    vertical-align: top;
  }
  tbody tr:nth-child(even) td { background: #FAFAFB; }
  .count { text-align: center; }
  .family { overflow-wrap: anywhere; }
  .empty { text-align: center; color: #5A5A66; }
  tfoot .total td {
    font-weight: 700;
    border-top: 0.75pt solid #7B2D43;
    border-bottom: none;
    background: #F6E9ED;
  }
</style>
</head>
<body>
${sections}
</body>
</html>`;
}

function renderGroup(group: ExportGroup): string {
  const meta = [
    group.date === null ? null : formatExportDay(group.date),
    plural(group.families.length, 'family', 'families'),
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  const rows =
    group.families
      .map((family) =>
        [
          '<tr>',
          `<td class="family">${escapeHtml(family.name)}</td>`,
          `<td class="count">${countCell(family.men)}</td>`,
          `<td class="count">${countCell(family.women)}</td>`,
          `<td class="count">${countCell(familyTotal(family))}</td>`,
          '</tr>',
        ].join('')
      )
      .join('') || '<tr><td class="empty" colspan="4">No families yet</td></tr>';

  const foot =
    group.families.length === 0
      ? ''
      : (() => {
          const counts = groupCounts(group);
          return [
            '<tfoot><tr class="total">',
            '<td class="family">TOTAL</td>',
            `<td class="count">${countCell(counts.men)}</td>`,
            `<td class="count">${countCell(counts.women)}</td>`,
            `<td class="count">${countCell(counts.total)}</td>`,
            '</tr></tfoot>',
          ].join('');
        })();

  return `<section class="group">
  <h1>${escapeHtml(group.name)}</h1>
  <p class="meta">${escapeHtml(meta)}</p>
  <table>
    <thead>
      <tr>
        <th class="family" style="width: 55%">Family</th>
        <th class="count" style="width: 15%">Men</th>
        <th class="count" style="width: 15%">Women</th>
        <th class="count" style="width: 15%">Total</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    ${foot}
  </table>
</section>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
