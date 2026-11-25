import fs from "node:fs";
import { parse } from "csv-parse/sync";

export function loadDemos(file = "data/demos.csv") {
  const content = fs.readFileSync(file, "utf8");
  // Excel and PowerShell both like to write a UTF-8 BOM. Without `bom: true` the
  // first header becomes "\uFEFFid" and every row looks like it is missing a column.
  const rows = parse(content, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  return rows.map((row, index) => {
    const id = String(row.id ?? "").replace(/^\uFEFF/, "").trim();
    const businessName = String(row.business_name ?? "").trim();
    const baseUrl = String(row.base_url ?? "").trim();

    if (!id || !businessName || !baseUrl) {
      throw new Error(`CSV row ${index + 2} requires id, business_name, base_url`);
    }

    let url;
    try { url = new URL(baseUrl); } catch { throw new Error(`Invalid URL at CSV row ${index + 2}`); }
    if (!["http:", "https:"].includes(url.protocol)) throw new Error(`Unsupported URL protocol: ${baseUrl}`);

    return { id, business_name: businessName, base_url: url.toString().replace(/\/$/, "") };
  });
}
