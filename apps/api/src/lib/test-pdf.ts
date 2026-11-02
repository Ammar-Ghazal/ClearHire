// Generates tiny, valid PDFs for tests, so no test depends on the real (gitignored) resumes.
// Each entry in `pages` is that page's text; an empty string makes a page with no text layer.

const escape = (text: string) => text.replace(/[\\()]/g, (c) => `\\${c}`);

export function makePdf(pages: string[]): Uint8Array {
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = pageIds.map((id) => `${id} 0 R`).join(' ');
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((text, i) => {
    const lines = text === '' ? [] : text.split('\n');
    const content = lines.length
      ? `BT /F1 10 Tf 14 TL 50 750 Td ${lines.map((l) => `(${escape(l)}) Tj T*`).join(' ')} ET`
      : '';
    objects[pageIds[i]!] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`;
    objects[pageIds[i]! + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** Enough text on one page to pass the scanned-document heuristic. */
export const resumeText = (name: string) =>
  Array.from(
    { length: 12 },
    (_, i) => `${name} built and maintained service number ${i + 1}.`,
  ).join('\n');
