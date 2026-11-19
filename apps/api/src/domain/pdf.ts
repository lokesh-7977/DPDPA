/**
 * Minimal PDF 1.4 writer, pure (no dependency): A4 pages of wrapped text in Helvetica /
 * Helvetica-Bold. Enough for generated reports. Characters outside printable Latin-1 are
 * replaced (standard fonts only cover WinAnsi).
 */

export type PdfBlock =
  | { kind: "title" | "heading" | "text" | "small"; text: string }
  | { kind: "space" }
  | { kind: "rule" };

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 50;
const STYLE = {
  title: { size: 20, bold: true, gap: 10 },
  heading: { size: 13, bold: true, gap: 6 },
  text: { size: 10, bold: false, gap: 2 },
  small: { size: 8, bold: false, gap: 1 },
} as const;

/** Printable Latin-1 only; PDF string escapes. */
const clean = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
const esc = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** Greedy word wrap by an average Helvetica glyph width (0.52 em; bold 0.56 em). */
function wrap(text: string, size: number, bold: boolean): string[] {
  const max = Math.floor((PAGE_W - 2 * MARGIN) / (size * (bold ? 0.56 : 0.52)));
  const out: string[] = [];
  for (const para of clean(text).split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const parts =
        word.length > max
          ? word.match(new RegExp(`.{1,${max}}`, "g"))!
          : [word];
      for (const w of parts) {
        if (!line) line = w;
        else if (line.length + 1 + w.length <= max) line += ` ${w}`;
        else {
          out.push(line);
          line = w;
        }
      }
    }
    out.push(line);
  }
  return out;
}

export function renderPdf(
  blocks: PdfBlock[],
  meta: { title: string; footer?: string },
): Uint8Array {
  const pages: string[][] = [[]];
  let y = PAGE_H - MARGIN;
  const newPage = () => {
    pages.push([]);
    y = PAGE_H - MARGIN;
  };
  const ops = () => pages[pages.length - 1]!;

  for (const b of blocks) {
    if (b.kind === "space") {
      y -= 10;
      continue;
    }
    if (b.kind === "rule") {
      if (y < MARGIN + 20) newPage();
      ops().push(`0.6 w ${MARGIN} ${y} m ${PAGE_W - MARGIN} ${y} l S`);
      y -= 12;
      continue;
    }
    const st = STYLE[b.kind];
    const lead = st.size * 1.3;
    if (b.kind === "heading" && y < MARGIN + 60) newPage();
    y -= st.gap;
    for (const line of wrap(b.text, st.size, st.bold)) {
      if (y - lead < MARGIN + 20) newPage();
      y -= lead;
      ops().push(
        `BT /${st.bold ? "F2" : "F1"} ${st.size} Tf ${MARGIN} ${y.toFixed(1)} Td (${esc(line)}) Tj ET`,
      );
    }
  }

  // Objects: 1 catalog, 2 pages, 3 F1, 4 F2, 5 info, then per page: page + content.
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 6 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objects[5] = `<< /Title (${esc(clean(meta.title))}) /Producer (dpdpa-platform) >>`;
  pages.forEach((content, i) => {
    const footer = `BT /F1 8 Tf ${MARGIN} 25 Td (${esc(clean(`${meta.footer ?? meta.title} - page ${i + 1} of ${pages.length}`))}) Tj ET`;
    const stream = [...content, footer].join("\n");
    objects[pageIds[i]!] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`;
    objects[pageIds[i]! + 1] =
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });

  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, "latin1");
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++)
    out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}
