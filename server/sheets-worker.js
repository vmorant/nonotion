// Lee una hoja de cálculo (xlsx, xls, ods, csv) en un hilo aparte para no
// bloquear el servidor con archivos grandes. Devuelve:
//  - sheets: datos para el visor (texto con el formato de Excel, celdas
//    combinadas y anchos de columna), limitados a MAX_ROWS × MAX_COLS por hoja;
//  - text: todas las hojas en CSV (para que Claude lea el contenido real).
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import * as XLSX from '@e965/xlsx';

const MAX_ROWS = 5000;
const MAX_COLS = 200;

const { filePath, ext, textLimit } = workerData;

try {
  const wb =
    ext === '.csv' || ext === '.tsv'
      ? XLSX.read(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''), { type: 'string', dense: true, dateNF: 'dd/mm/yyyy', FS: ext === '.tsv' ? '\t' : undefined })
      : XLSX.read(fs.readFileSync(filePath), { type: 'buffer', dense: true, cellStyles: true, dateNF: 'dd/mm/yyyy' });

  const meta = wb.Workbook?.Sheets || [];
  const sheets = [];
  let text = '';
  wb.SheetNames.forEach((name, idx) => {
    const ws = wb.Sheets[name];
    const ref = ws['!ref'];
    if (!ref) {
      sheets.push({ name, hidden: !!meta[idx]?.Hidden, rows: [], totalRows: 0, totalCols: 0, merges: [], widths: [] });
      return;
    }
    // El rango declarado puede ser enorme aunque esté casi vacío: se recorta a
    // las filas y columnas que tienen datos de verdad
    const range = XLSX.utils.decode_range(ref);
    const data = ws['!data'] || [];
    let lastRow = Math.min(range.e.r, data.length - 1);
    while (lastRow >= range.s.r && !(data[lastRow] || []).some((c) => c && c.v !== undefined && c.v !== '')) lastRow--;
    let lastCol = range.s.c;
    for (let r = range.s.r; r <= lastRow; r++) {
      const row = data[r] || [];
      for (let c = Math.min(range.e.c, row.length - 1); c > lastCol; c--) {
        if (row[c] && row[c].v !== undefined && row[c].v !== '') {
          lastCol = c;
          break;
        }
      }
    }
    for (const m of ws['!merges'] || []) {
      if (m.s.r <= lastRow) lastCol = Math.max(lastCol, Math.min(m.e.c, range.e.c));
    }
    const full = { s: { r: 0, c: 0 }, e: { r: Math.max(lastRow, 0), c: lastCol } };
    const totalRows = lastRow + 1;
    const totalCols = lastCol + 1;

    const viewRange = { s: full.s, e: { r: Math.min(full.e.r, MAX_ROWS - 1), c: Math.min(full.e.c, MAX_COLS - 1) } };
    const rows = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: true,
      range: XLSX.utils.encode_range(viewRange),
    });
    const merges = (ws['!merges'] || [])
      .filter((m) => m.s.r <= viewRange.e.r && m.s.c <= viewRange.e.c)
      .map((m) => ({ r: m.s.r, c: m.s.c, rs: Math.min(m.e.r, viewRange.e.r) - m.s.r + 1, cs: Math.min(m.e.c, viewRange.e.c) - m.s.c + 1 }));
    const widths = (ws['!cols'] || []).slice(0, viewRange.e.c + 1).map((col) => {
      if (!col || col.hidden) return col?.hidden ? 0 : null;
      if (col.wpx) return Math.round(col.wpx);
      if (col.wch) return Math.round(col.wch * 7 + 10);
      if (col.width) return Math.round(col.width * 7);
      return null;
    });
    sheets.push({
      name,
      hidden: !!meta[idx]?.Hidden,
      rows,
      totalRows,
      totalCols,
      truncatedRows: totalRows > rows.length,
      truncatedCols: totalCols > viewRange.e.c + 1,
      merges,
      widths,
    });

    if (text.length < textLimit) {
      const csv = XLSX.utils.sheet_to_csv(ws, { range: XLSX.utils.encode_range(full), blankrows: false, strip: true });
      text += `### Hoja: ${name}${meta[idx]?.Hidden ? ' (oculta)' : ''} — ${totalRows} filas × ${totalCols} columnas\n${csv}\n\n`;
    }
  });
  const truncated = text.length > textLimit;
  parentPort.postMessage({ ok: true, sheets, text: truncated ? text.slice(0, textLimit) : text, chars: text.length, truncated });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.message || String(e) });
}
