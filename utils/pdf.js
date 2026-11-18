// A small PDF writer for receipts and payout statements: A4 pages with text (Helvetica, regular and bold),
// lines and filled boxes. No library needed. Text is written in the PDF's built-in Latin encoding, so the rupee
// sign is written as "Rs." and letters outside Latin-1 become "?".

const PAGE = { width: 595, height: 842 };

// rough Helvetica widths (share of the font size), enough to right-align amounts
const widthOf = (text, size, bold) => {
  let units = 0;
  for (const char of text) {
    if ("il.,:;|!'".includes(char)) units += 0.28;
    else if ("mwMW".includes(char)) units += 0.85;
    else if (/[A-Z0-9]/.test(char)) units += 0.64;
    else if (char === " ") units += 0.28;
    else units += 0.52;
  }
  return units * size * (bold ? 1.05 : 1);
};

const clean = text =>
  String(text ?? "")
    .replace(/₹/g, "Rs. ")
    .replace(/[–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
const escape = text => clean(text).replace(/[\\()]/g, char => `\\${char}`);

// splits text into lines that fit `maxWidth` at this size (long words are cut)
export const wrapText = (value, size, maxWidth, bold = false) => {
  const lines = [];
  for (const paragraph of String(value ?? "").split("\n").map(clean)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (widthOf(next, size, bold) <= maxWidth) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      line = word;
      while (widthOf(line, size, bold) > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && widthOf(line.slice(0, cut), size, bold) > maxWidth) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
};

export const createPdf = () => {
  const pages = [[]];
  const page = () => pages[pages.length - 1];
  const api = {
    width: PAGE.width,
    height: PAGE.height,
    // y is measured from the top of the page
    text(value, x, y, { size = 10, bold = false, color = [0.1, 0.12, 0.16], align = "left", maxWidth } = {}) {
      let string = clean(value);
      // too long for its column: shortened with "..."
      if (maxWidth && widthOf(string, size, bold) > maxWidth) {
        while (string.length > 1 && widthOf(`${string}...`, size, bold) > maxWidth) string = string.slice(0, -1);
        string = `${string.trimEnd()}...`;
      }
      const left = align === "right" ? x - widthOf(string, size, bold) : align === "center" ? x - widthOf(string, size, bold) / 2 : x;
      page().push(`BT ${color.join(" ")} rg /${bold ? "F2" : "F1"} ${size} Tf ${left.toFixed(1)} ${(PAGE.height - y).toFixed(1)} Td (${escape(string)}) Tj ET`);
      return api;
    },
    line(x1, y1, x2, y2, { color = [0.85, 0.88, 0.92], width = 1 } = {}) {
      page().push(`${color.join(" ")} RG ${width} w ${x1} ${PAGE.height - y1} m ${x2} ${PAGE.height - y2} l S`);
      return api;
    },
    box(x, y, w, h, { fill = [0.95, 0.97, 0.99] } = {}) {
      page().push(`${fill.join(" ")} rg ${x} ${PAGE.height - y - h} ${w} ${h} re f`);
      return api;
    },
    addPage() {
      pages.push([]);
      return api;
    },
    // the finished file
    toBuffer() {
      const objects = [];
      const add = body => objects.push(body) && objects.length;
      const catalog = add("");
      const pagesId = add("");
      const regular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
      const bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
      const kids = pages.map(commands => {
        const content = commands.join("\n");
        const stream = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
        return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${stream} 0 R >>`);
      });
      objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
      objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map(id => `${id} 0 R`).join(" ")}] /Count ${kids.length} >>`;
      let pdf = "%PDF-1.4\n";
      const offsets = objects.map((object, index) => {
        const offset = Buffer.byteLength(pdf, "latin1");
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
        return offset;
      });
      const xref = Buffer.byteLength(pdf, "latin1");
      pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
      pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      return Buffer.from(pdf, "latin1");
    },
  };
  return api;
};
