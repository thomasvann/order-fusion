import { useState, useCallback, useRef, useEffect } from "react";
import * as XLSX from "xlsx";

async function notionRequest({ path, method = "GET", body }) {
  const res = await fetch("/api/notion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, method, body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || data?.error || `Notion error ${res.status}`);
  return data;
}

async function fetchNotionDatabases() {
  const data = await notionRequest({
    path: "/search",
    method: "POST",
    body: { filter: { value: "database", property: "object" }, page_size: 50 },
  });
  return data.results || [];
}

async function fetchDatabaseSchema(databaseId) {
  const data = await notionRequest({ path: `/databases/${databaseId}` });
  return data.properties || {};
}

async function createNotionPage(databaseId, properties) {
  return notionRequest({
    path: "/pages",
    method: "POST",
    body: { parent: { database_id: databaseId }, properties },
  });
}

function buildNotionProperty(value, propType) {
  const s = String(value ?? "").trim();
  if (!s) return null;
  switch (propType) {
    case "title":      return { title: [{ text: { content: s } }] };
    case "rich_text":  return { rich_text: [{ text: { content: s } }] };
    case "number": {
      const n = parseFloat(s.replace(/[^0-9.-]/g, ""));
      return isNaN(n) ? null : { number: n };
    }
    case "url":          return /^https?:\/\//i.test(s) ? { url: s } : { url: `https://${s}` };
    case "email":        return { email: s };
    case "phone_number": return { phone_number: s };
    case "checkbox":     return { checkbox: s.toLowerCase() === "true" || s === "1" };
    case "select":       return { select: { name: s } };
    case "multi_select": return { multi_select: s.split(",").map((v) => ({ name: v.trim() })) };
    case "date":         return { date: { start: s } };
    default:             return { rich_text: [{ text: { content: s } }] };
  }
}

function formatHeader(h) {
  if (h.toLowerCase() === "url") return "URL";
  return h.charAt(0).toUpperCase() + h.slice(1);
}

const isUrl = (v) => {
  if (typeof v !== "string") return false;
  const s = v.trim();
  return /^https?:\/\//i.test(s) || /^www\./i.test(s) || /^[a-z0-9-]+\.[a-z]{2,}(\/|$)/i.test(s);
};
const isInteger = (v) => { const n = Number(v); return v !== "" && v != null && !isNaN(n) && Number.isInteger(n); };
const isFloat   = (v) => { const n = Number(v); return v !== "" && v != null && !isNaN(n) && !Number.isInteger(n); };
const isNumericLike = (v) => isInteger(v) || isFloat(v);

const HEADER_KEYWORDS = {
  float:   [/price/i,/cost/i,/amount/i,/total/i,/subtotal/i,/value/i,/fee/i,/charge/i,/rate/i,/sale/i,/revenue/i,/profit/i,/spend/i,/budget/i],
  integer: [/qty/i,/quant/i,/count/i,/num(ber)?/i,/units?/i,/stock/i,/inventory/i,/order(ed)?/i,/sold/i,/available/i],
  url:     [/url/i,/link/i,/href/i,/website/i,/site/i,/web/i,/http/i,/address/i],
  text:    [/name/i,/title/i,/desc/i,/product/i,/item/i,/label/i,/brand/i,/sku/i,/model/i,/category/i,/type/i,/note/i,/comment/i],
};

function inferColType(headerName, values) {
  const h = String(headerName ?? "").trim();
  for (const [type, patterns] of Object.entries(HEADER_KEYWORDS))
    if (patterns.some((p) => p.test(h))) return type;
  const ne = values.filter((v) => v !== "" && v != null);
  if (!ne.length) return "unknown";
  const c = { url: 0, integer: 0, float: 0, text: 0 };
  ne.forEach((v) => {
    const s = String(v).trim();
    if (isUrl(s)) c.url++;
    else if (isFloat(s)) c.float++;
    else if (isInteger(s)) c.integer++;
    else c.text++;
  });
  const [type] = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return c[type] === 0 ? "unknown" : type;
}

function detectFirstRowRole(rows) {
  if (!rows || !rows.length) return "header";
  const first = rows[0];
  if (rows.length === 1) {
    const n = first.filter((v) => isNumericLike(String(v).trim())).length;
    const u = first.filter((v) => isUrl(String(v).trim())).length;
    return n + u > first.length * 0.4 ? "data" : "header";
  }
  const dr = rows.slice(1, Math.min(10, rows.length));
  const cols = first.length;
  let fs = 0, bs = 0;
  for (let c = 0; c < cols; c++) {
    const fv = String(first[c] ?? "").trim();
    const bv = dr.map((r) => String(r[c] ?? "").trim()).filter(Boolean);
    const bnr = bv.filter(isNumericLike).length / (bv.length || 1);
    const bur = bv.filter(isUrl).length / (bv.length || 1);
    if (bnr > 0.5 && isNumericLike(fv)) fs++;
    if (bur > 0.5 && isUrl(fv)) fs++;
    if (bnr > 0.5 && !isNumericLike(fv)) bs++;
    if (bur > 0.5 && !isUrl(fv)) bs++;
  }
  return bs > 0 && fs / bs > 0.5 ? "data" : "header";
}

const NOTION_PROP_META = {
  title:        { color: "#be185d", icon: "★" },
  rich_text:    { color: "#374151", icon: "T" },
  number:       { color: "#065f46", icon: "#" },
  url:          { color: "#1e40af", icon: "↗" },
  email:        { color: "#5b21b6", icon: "@" },
  phone_number: { color: "#7c3aed", icon: "☎" },
  checkbox:     { color: "#065f46", icon: "✓" },
  select:       { color: "#92400e", icon: "◉" },
  multi_select: { color: "#9a3412", icon: "⊕" },
  date:         { color: "#1e3a8a", icon: "📅" },
  formula:      { color: "#6b7280", icon: "ƒ" },
  rollup:       { color: "#6b7280", icon: "⟳" },
  relation:     { color: "#6b7280", icon: "↔" },
};

function parseCsvText(text) {
  const rows = [];
  let row = [], field = "", inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (inQuote) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuote = false; }
      else { field += ch; }
    } else {
      if (ch === '"') { inQuote = true; }
      else if (ch === ',') { row.push(field); field = ""; }
      else if (ch === '\r' && next === '\n') { row.push(field); rows.push(row); row = []; field = ""; i++; }
      else if (ch === '\n' || ch === '\r') { row.push(field); rows.push(row); row = []; field = ""; }
      else { field += ch; }
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function parseFile(file) {
  const isCsv = file.name.toLowerCase().endsWith(".csv");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        let raw;
        if (isCsv) {
          raw = parseCsvText(e.target.result);
        } else {
          const uint8 = new Uint8Array(e.target.result);
          const wb = XLSX.read(uint8, { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        }
        const cleaned = raw.filter((r) => r.some((c) => String(c).trim() !== ""));
        if (!cleaned.length) { resolve({ name: file.name, headers: [], dataRows: [] }); return; }
        const role = detectFirstRowRole(cleaned);
        let headers, dataRows;
        if (role === "header") {
          headers = cleaned[0].map((h, i) => formatHeader(String(h ?? "").trim() || `Col ${i + 1}`));
          dataRows = cleaned.slice(1);
        } else {
          headers = cleaned[0].map((_, i) => `Col ${i + 1}`);
          dataRows = cleaned;
        }
        resolve({ name: file.name, headers, dataRows });
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    if (isCsv) reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  });
}

// ── Drop Zone ──
function DropZone({ label, sublabel, accept, onFile, file }) {
  const [drag, setDrag] = useState(false);
  const ref = useRef();
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
      onClick={() => ref.current.click()}
      style={{
        border: `2px dashed ${drag ? "#2563eb" : file ? "#16a34a" : "#d1d5db"}`,
        borderRadius: "10px",
        padding: "24px 16px",
        cursor: "pointer",
        background: drag ? "#eff6ff" : file ? "#f0fdf4" : "#fafafa",
        transition: "all 0.15s",
        textAlign: "center",
      }}
    >
      <input ref={ref} type="file" accept={accept} style={{ display: "none" }} onChange={(e) => e.target.files[0] && onFile(e.target.files[0])} />
      <div style={{ fontSize: "1.4rem", marginBottom: "6px" }}>{file ? "✅" : "📄"}</div>
      <div style={{ color: file ? "#15803d" : "#6b7280", fontSize: "0.82rem", fontWeight: 500 }}>
        {file ? file.name : label}
      </div>
      {sublabel && !file && <div style={{ color: "#9ca3af", fontSize: "0.72rem", marginTop: "3px" }}>{sublabel}</div>}
    </div>
  );
}

// ── Table cell ──
function Cell({ value, type }) {
  const s = String(value ?? "").trim();
  if (!s) return <span style={{ color: "#d1d5db" }}>—</span>;
  if (type === "url" || isUrl(s)) {
    const href = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    return <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: "#2563eb", fontSize: "0.78rem" }}>↗ {s.length > 30 ? s.slice(0, 30) + "…" : s}</a>;
  }
  if (type === "float")   return <span style={{ color: "#065f46" }}>${parseFloat(s).toFixed(2)}</span>;
  if (type === "integer") return <span style={{ color: "#1e40af" }}>{parseInt(s).toLocaleString()}</span>;
  return <span style={{ color: "#111827" }}>{s}</span>;
}

// ── Notion Setup Modal ──
function NotionSetupModal({ onSave, onClose }) {
  const [draft, setDraft] = useState(localStorage.getItem("notionToken") || "");
  const save = () => { const t = draft.trim(); if (!t) return; localStorage.setItem("notionToken", t); onSave(t); };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px" }}>
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: "14px", padding: "28px", maxWidth: "520px", width: "100%", boxShadow: "0 4px 24px rgba(0,0,0,0.10)" }}>
        <div style={{ fontWeight: 600, fontSize: "1rem", color: "#111827", marginBottom: "6px" }}>Connect Notion</div>
        <div style={{ color: "#6b7280", fontSize: "0.78rem", lineHeight: 2, marginBottom: "20px" }}>
          You need a Notion Internal Integration token.<br />
          1. Go to <a href="https://www.notion.so/my-integrations" target="_blank" rel="noopener noreferrer" style={{ color: "#2563eb" }}>notion.so/my-integrations</a><br />
          2. Click <strong>+ New integration</strong> → give it a name → Submit<br />
          3. Copy the <strong>Internal Integration Token</strong> (starts with <code style={{ background: "#f3f4f6", padding: "1px 5px", borderRadius: "4px" }}>secret_</code>)<br />
          4. In your Notion database → <strong>⋯ Menu → Add connections</strong> → select your integration<br />
          5. Paste the token below
        </div>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="secret_xxxxxxxxxxxxxxxxxxxxxxxxx"
          style={{ width: "100%", background: "#f9fafb", border: "1px solid #d1d5db", borderRadius: "8px", padding: "10px 12px", color: "#111827", fontSize: "0.82rem", fontFamily: "monospace", marginBottom: "14px", outline: "none", boxSizing: "border-box" }}
        />
        <div style={{ display: "flex", gap: "10px" }}>
          <button onClick={save} style={{ background: "#2563eb", color: "#fff", border: "none", borderRadius: "8px", padding: "9px 20px", fontWeight: 600, fontSize: "0.8rem", cursor: "pointer" }}>Save & connect</button>
          <button onClick={onClose} style={{ background: "transparent", border: "1px solid #d1d5db", color: "#6b7280", borderRadius: "8px", padding: "9px 20px", fontWeight: 600, fontSize: "0.8rem", cursor: "pointer" }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── Database Picker Modal ──
function DatabasePickerModal({ onSelect, onClose }) {
  const [databases, setDatabases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedDb, setSelectedDb] = useState(null);

  useEffect(() => {
    fetchNotionDatabases()
      .then((dbs) => { setDatabases(dbs); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, []);

  const getDbTitle = (db) => db.title?.[0]?.plain_text || "Untitled Database";

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px" }}>
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: "14px", padding: "28px", maxWidth: "480px", width: "100%", maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 4px 24px rgba(0,0,0,0.10)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "18px" }}>
          <div style={{ fontWeight: 600, fontSize: "1rem", color: "#111827" }}>Choose a Notion database</div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: "1.2rem", lineHeight: 1 }}>✕</button>
        </div>

        {loading && <div style={{ color: "#6b7280", fontSize: "0.82rem", textAlign: "center", padding: "30px" }}>Loading databases…</div>}
        {error && <div style={{ color: "#dc2626", fontSize: "0.75rem", padding: "8px", background: "#fef2f2", borderRadius: "8px" }}>⚠ {error}<br /><span style={{ color: "#6b7280" }}>Make sure your integration has been added to at least one database.</span></div>}

        {!loading && !error && (
          <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: "6px" }}>
            {databases.length === 0 && (
              <div style={{ color: "#6b7280", fontSize: "0.78rem", textAlign: "center", padding: "20px", lineHeight: 1.8 }}>
                No databases found.<br />Add your integration in Notion via <strong>⋯ Menu → Add connections</strong>.
              </div>
            )}
            {databases.map((db) => (
              <div key={db.id} onClick={() => setSelectedDb(db)}
                style={{ padding: "12px 14px", borderRadius: "10px", cursor: "pointer", background: selectedDb?.id === db.id ? "#eff6ff" : "#f9fafb", border: `1.5px solid ${selectedDb?.id === db.id ? "#2563eb" : "#e5e7eb"}`, display: "flex", alignItems: "center", gap: "10px", transition: "all 0.15s" }}>
                <span style={{ fontSize: "1rem" }}>🗄</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: selectedDb?.id === db.id ? "#1d4ed8" : "#111827", fontSize: "0.85rem", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{getDbTitle(db)}</div>
                  <div style={{ color: "#9ca3af", fontSize: "0.65rem", marginTop: "2px", fontFamily: "monospace" }}>{db.id}</div>
                </div>
                {selectedDb?.id === db.id && <span style={{ color: "#2563eb" }}>✓</span>}
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: "18px", display: "flex", gap: "10px", justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ background: "transparent", border: "1px solid #d1d5db", color: "#6b7280", borderRadius: "8px", padding: "8px 16px", fontWeight: 600, fontSize: "0.78rem", cursor: "pointer" }}>Cancel</button>
          <button onClick={() => selectedDb && onSelect(selectedDb)} disabled={!selectedDb}
            style={{ background: !selectedDb ? "#e5e7eb" : "#2563eb", color: !selectedDb ? "#9ca3af" : "#fff", border: "none", borderRadius: "8px", padding: "8px 18px", fontWeight: 600, fontSize: "0.78rem", cursor: !selectedDb ? "not-allowed" : "pointer" }}>
            Use this database
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Column Mapper Modal ──
function ColumnMapperModal({ spreadsheetHeaders, notionSchema, onConfirm, onClose }) {
  const autoMap = () => {
    const mapping = {};
    spreadsheetHeaders.forEach((h) => {
      const lower = h.toLowerCase().trim();
      const exact = Object.keys(notionSchema).find((k) => k.toLowerCase() === lower);
      if (exact) { mapping[h] = exact; return; }
      if (lower === "timestamp") {
        const tsProp = Object.keys(notionSchema).find((k) => k.toLowerCase() === "timestamp");
        if (tsProp) { mapping[h] = tsProp; return; }
      }
      const looksLikeUrl = /url|link|href|website|site/i.test(lower);
      if (looksLikeUrl) {
        const urlProp = Object.keys(notionSchema).find((k) => notionSchema[k].type === "url");
        if (urlProp) { mapping[h] = urlProp; return; }
      }
      const partial = Object.keys(notionSchema).find((k) => k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase()));
      if (partial) mapping[h] = partial;
    });
    return mapping;
  };

  const [mapping, setMapping] = useState(autoMap);
  const editableProps = Object.entries(notionSchema).filter(([, p]) => !["formula","rollup","relation","created_time","last_edited_time","created_by","last_edited_by"].includes(p.type));
  const setMap = (header, notionProp) => setMapping((prev) => ({ ...prev, [header]: notionProp || undefined }));
  const mappedCount = Object.values(mapping).filter(Boolean).length;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px" }}>
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: "14px", padding: "28px", maxWidth: "620px", width: "100%", maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 4px 24px rgba(0,0,0,0.10)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
          <div style={{ fontWeight: 600, fontSize: "1rem", color: "#111827" }}>Map columns to Notion</div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: "1.2rem", lineHeight: 1 }}>✕</button>
        </div>
        <p style={{ color: "#6b7280", fontSize: "0.78rem", margin: "0 0 16px" }}>Match each spreadsheet column to the right Notion property. Skip any you don't need.</p>

        <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: "6px" }}>
          {spreadsheetHeaders.map((h) => {
            const currentVal = mapping[h] || "";
            const notionProp = notionSchema[currentVal];
            const meta = NOTION_PROP_META[notionProp?.type] || { color: "#6b7280", icon: "?" };
            return (
              <div key={h} style={{ display: "flex", alignItems: "center", gap: "10px", background: "#f9fafb", borderRadius: "8px", padding: "10px 12px", border: `1px solid ${currentVal ? "#bfdbfe" : "#e5e7eb"}` }}>
                <div style={{ flex: "0 0 160px", minWidth: 0 }}>
                  <div style={{ color: "#111827", fontSize: "0.82rem", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h}</div>
                  <div style={{ color: "#9ca3af", fontSize: "0.65rem" }}>spreadsheet column</div>
                </div>
                <div style={{ color: "#9ca3af" }}>→</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <select value={currentVal} onChange={(e) => setMap(h, e.target.value)}
                    style={{ width: "100%", background: "#fff", border: `1px solid ${currentVal ? "#2563eb" : "#d1d5db"}`, borderRadius: "7px", padding: "6px 10px", color: currentVal ? "#1d4ed8" : "#6b7280", fontSize: "0.78rem", outline: "none", cursor: "pointer" }}>
                    <option value="">— skip this column —</option>
                    {editableProps.map(([name, prop]) => {
                      const m = NOTION_PROP_META[prop.type] || { icon: "?" };
                      return <option key={name} value={name}>{m.icon} {name} ({prop.type})</option>;
                    })}
                  </select>
                  {currentVal && notionProp?.type === "rich_text" && /url|link|href|website/i.test(h) && (
                    <div style={{ color: "#d97706", fontSize: "0.65rem", marginTop: "3px" }}>⚠ Looks like a URL — consider mapping to a url property instead</div>
                  )}
                </div>
                {notionProp && (
                  <div style={{ flexShrink: 0, background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: "6px", padding: "3px 8px", fontSize: "0.65rem", color: meta.color, fontWeight: 600, whiteSpace: "nowrap" }}>
                    {meta.icon} {notionProp.type}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: "16px", paddingTop: "14px", borderTop: "1px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ color: "#6b7280", fontSize: "0.75rem" }}>{mappedCount} of {spreadsheetHeaders.length} columns mapped</span>
          <div style={{ display: "flex", gap: "10px" }}>
            <button onClick={onClose} style={{ background: "transparent", border: "1px solid #d1d5db", color: "#6b7280", borderRadius: "8px", padding: "8px 16px", fontWeight: 600, fontSize: "0.78rem", cursor: "pointer" }}>Cancel</button>
            <button onClick={() => onConfirm(mapping)} disabled={mappedCount === 0}
              style={{ background: mappedCount === 0 ? "#e5e7eb" : "#2563eb", color: mappedCount === 0 ? "#9ca3af" : "#fff", border: "none", borderRadius: "8px", padding: "8px 18px", fontWeight: 600, fontSize: "0.78rem", cursor: mappedCount === 0 ? "not-allowed" : "pointer" }}>
              Confirm mapping
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Push Progress Modal ──
function PushProgressModal({ total, pushed, failed, onClose, done }) {
  const pct = total > 0 ? Math.round((pushed + failed) / total * 100) : 0;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px" }}>
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: "14px", padding: "32px", maxWidth: "380px", width: "100%", textAlign: "center", boxShadow: "0 4px 24px rgba(0,0,0,0.10)" }}>
        <div style={{ fontWeight: 600, fontSize: "1rem", color: done ? "#16a34a" : "#111827", marginBottom: "8px" }}>
          {done ? "Upload complete" : "Sending to Notion…"}
        </div>
        <div style={{ color: "#6b7280", fontSize: "0.78rem", marginBottom: "20px" }}>
          {pushed + failed} of {total} rows processed
        </div>
        <div style={{ background: "#f3f4f6", borderRadius: "4px", height: "8px", marginBottom: "18px", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: failed > 0 ? "#ef4444" : "#2563eb", borderRadius: "4px", transition: "width 0.3s ease" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "center", gap: "24px", marginBottom: "20px" }}>
          <div>
            <div style={{ color: "#16a34a", fontWeight: 700, fontSize: "1.4rem" }}>{pushed}</div>
            <div style={{ color: "#9ca3af", fontSize: "0.65rem", letterSpacing: "1px" }}>sent</div>
          </div>
          {failed > 0 && (
            <div>
              <div style={{ color: "#dc2626", fontWeight: 700, fontSize: "1.4rem" }}>{failed}</div>
              <div style={{ color: "#9ca3af", fontSize: "0.65rem", letterSpacing: "1px" }}>failed</div>
            </div>
          )}
        </div>
        {done && (
          <button onClick={onClose} style={{ background: "#2563eb", color: "#fff", border: "none", borderRadius: "8px", padding: "9px 24px", fontWeight: 600, fontSize: "0.8rem", cursor: "pointer" }}>Done</button>
        )}
      </div>
    </div>
  );
}

function buildAutoMap(headers, notionSchema) {
  const mapping = {};
  headers.forEach((h) => {
    const lower = h.toLowerCase().trim();
    const exact = Object.keys(notionSchema).find((k) => k.toLowerCase() === lower);
    if (exact) { mapping[h] = exact; return; }
    const looksLikeUrl = /url|link|href|website|site/i.test(lower);
    if (looksLikeUrl) {
      const urlProp = Object.keys(notionSchema).find((k) => notionSchema[k].type === "url");
      if (urlProp) { mapping[h] = urlProp; return; }
    }
    const partial = Object.keys(notionSchema).find((k) => k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase()));
    if (partial) mapping[h] = partial;
  });
  return mapping;
}

// ── Main App ──
export default function App() {
  const [file1, setFile1] = useState(null);
  const [uploadTimestamp, setUploadTimestamp] = useState(null);
  const [sheetUrl, setSheetUrl] = useState("");
  const [orderer, setOrderer] = useState("");
  const [projectTeam, setProjectTeam] = useState("");
  const [mergedData, setMergedData] = useState(null);
  const [headers, setHeaders] = useState([]);
  const [colTypes, setColTypes] = useState({});
  const [parseInfo, setParseInfo] = useState([]);
  const [showDbPicker, setShowDbPicker] = useState(false);
  const [targetDb, setTargetDb] = useState({ id: "31a9b1412417803abaf5e164229a0d54", title: "Orders" });
  const [notionSchema, setNotionSchema] = useState(null);
  const [columnMapping, setColumnMapping] = useState(null);
  const [pushing, setPushing] = useState(false);
  const [pushProgress, setPushProgress] = useState(null);
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState("asc");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchDatabaseSchema("31a9b1412417803abaf5e164229a0d54")
      .then((schema) => setNotionSchema(schema))
      .catch((e) => setError("Could not load Notion schema: " + e.message));
  }, []);

  const handleDbSelected = useCallback(async (db) => {
    const title = db.title?.[0]?.plain_text || "Untitled";
    setTargetDb({ id: db.id, title });
    setShowDbPicker(false);
    setColumnMapping(null);
    try {
      const schema = await fetchDatabaseSchema(db.id);
      setNotionSchema(schema);
    } catch (e) { setError("Could not load database schema: " + e.message); }
  }, []);

  const toSheetCsvUrl = (url) => {
    const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!idMatch) return null;
    const id = idMatch[1];
    const gidMatch = url.match(/[#&?]gid=(\d+)/);
    const gid = gidMatch ? gidMatch[1] : "0";
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  };

  const merge = useCallback(async () => {
    const hasFile = !!file1;
    const hasUrl  = sheetUrl.trim().length > 0;
    if (!hasFile && !hasUrl) { setError("Please upload a file or paste a Google Sheet link first."); return; }
    if (hasUrl && !/spreadsheets\/d\//.test(sheetUrl)) { setError("That doesn't look like a valid Google Sheets URL."); return; }

    setLoading(true); setError(null); setColumnMapping(null);
    try {
      let r1, sourceName;
      if (hasUrl) {
        const csvUrl = toSheetCsvUrl(sheetUrl.trim());
        if (!csvUrl) throw new Error("Could not parse Google Sheets URL.");
        const res = await fetch(csvUrl);
        if (!res.ok) throw new Error(`Could not fetch sheet (${res.status}). Make sure it is shared as "Anyone with the link can view".`);
        const text = await res.text();
        const raw = parseCsvText(text);
        const cleaned = raw.filter((row) => row.some((c) => String(c).trim() !== ""));
        if (!cleaned.length) throw new Error("Sheet appears to be empty.");
        const role = detectFirstRowRole(cleaned);
        let hdrs, dataRows;
        if (role === "header") {
          hdrs = cleaned[0].map((h, i) => formatHeader(String(h ?? "").trim() || `Col ${i + 1}`));
          dataRows = cleaned.slice(1);
        } else {
          hdrs = cleaned[0].map((_, i) => `Col ${i + 1}`);
          dataRows = cleaned;
        }
        sourceName = "Google Sheet";
        r1 = { name: sourceName, headers: hdrs, dataRows };
      } else {
        r1 = await parseFile(file1);
        sourceName = file1.name;
      }

      const hasSheetLink = hasUrl && sheetUrl.trim();
      const hdrs = [...r1.headers, ...(hasSheetLink ? ["Spreadsheet Link"] : []), "Timestamp", "Orderer", "Project Team"];
      const ts = uploadTimestamp ? uploadTimestamp.toLocaleString() : new Date().toLocaleString();
      const cleanSheetUrl = hasSheetLink ? sheetUrl.trim().split("/export")[0].replace(/\/(edit|pub|view).*$/, "") : "";

      const rows1 = r1.dataRows.filter((row) => row.some((c) => c !== "")).map((row) => {
        const obj = { _source: sourceName, _origin: "file1" };
        r1.headers.forEach((h, i) => { obj[h] = row[i] ?? ""; });
        if (hasSheetLink) obj["Spreadsheet Link"] = cleanSheetUrl;
        obj["Timestamp"] = ts;
        obj["Orderer"] = orderer;
        obj["Project Team"] = projectTeam;
        return obj;
      });

      const types = {};
      hdrs.forEach((h) => { types[h] = inferColType(h, rows1.map((r) => String(r[h] ?? "").trim())); });
      if (hasSheetLink) types["Spreadsheet Link"] = "url";
      types["Timestamp"] = "text";
      types["Orderer"] = "text";
      types["Project Team"] = "text";

      setHeaders(hdrs);
      setColTypes(types);
      setMergedData(rows1);
      setParseInfo([`Source: ${sourceName}`, `${r1.dataRows.length} rows`, `Processed: ${ts}`]);
      setSortCol(null);
    } catch (e) { setError("Error: " + e.message); }
    setLoading(false);
  }, [file1, sheetUrl, uploadTimestamp, orderer, projectTeam]);

  const pushToNotion = useCallback(async (mapping) => {
    setColumnMapping(mapping);
    if (!mergedData || !targetDb || !notionSchema) return;
    const mappedEntries = Object.entries(mapping).filter(([, v]) => v);
    if (!mappedEntries.length) { setError("No columns mapped."); return; }
    setPushing(true);
    setPushProgress({ total: mergedData.length, pushed: 0, failed: 0 });
    let pushed = 0, failed = 0;
    for (const row of mergedData) {
      const properties = {};
      for (const [spreadsheetCol, notionProp] of mappedEntries) {
        const propSchema = notionSchema[notionProp];
        if (!propSchema) continue;
        const built = buildNotionProperty(row[spreadsheetCol], propSchema.type);
        if (built) properties[notionProp] = built;
      }
      const slValue = row["Spreadsheet Link"];
      if (slValue) {
        const slPropName = notionSchema["Spreadsheet Link"] ? "Spreadsheet Link" : Object.keys(notionSchema).find((k) => k.toLowerCase() === "spreadsheet link");
        if (slPropName && notionSchema[slPropName]) {
          const built = buildNotionProperty(slValue, notionSchema[slPropName].type || "url");
          if (built) properties[slPropName] = built;
        }
      }
      try { await createNotionPage(targetDb.id, properties); pushed++; } catch { failed++; }
      setPushProgress({ total: mergedData.length, pushed, failed });
    }
    setPushing(false);
  }, [mergedData, targetDb, notionSchema]);

  const autoPushToNotion = useCallback(async () => {
    if (!targetDb) { setShowDbPicker(true); return; }
    let schema = notionSchema;
    if (!schema) {
      try { schema = await fetchDatabaseSchema(targetDb.id); setNotionSchema(schema); }
      catch (e) { setError("Could not load schema: " + e.message); return; }
    }
    const headersToMap = headers.filter((h) => h !== "Spreadsheet Link");
    const mapping = buildAutoMap(headersToMap, schema);
    await pushToNotion(mapping);
  }, [targetDb, notionSchema, headers, pushToNotion]);

  const handleSort = (col) => {
    if (sortCol === col) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
  };

  const displayRows = mergedData ? [...mergedData].sort((a, b) => {
    if (!sortCol) return 0;
    const av = a[sortCol], bv = b[sortCol];
    const an = parseFloat(av), bn = parseFloat(bv);
    if (!isNaN(an) && !isNaN(bn)) return sortDir === "asc" ? an - bn : bn - an;
    return sortDir === "asc" ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
  }) : [];

  const floatCols = headers.filter((h) => colTypes[h] === "float");
  const intCols   = headers.filter((h) => colTypes[h] === "integer");
  const totalRevenue = mergedData && floatCols[0] ? mergedData.reduce((s, r) => s + (parseFloat(r[floatCols[0]]) || 0), 0) : null;
  const totalQty     = mergedData && intCols[0] ? mergedData.reduce((s, r) => s + (parseInt(r[intCols[0]]) || 0), 0) : null;

  const notionReady = !!targetDb && !!notionSchema;
  const META_COLS = ["Orderer", "Project Team", "Timestamp", "Spreadsheet Link"];
  const displayHeaders = headers.filter((h) => !META_COLS.includes(h));

  const inputStyle = { width: "100%", background: "#fff", border: "1px solid #d1d5db", borderRadius: "8px", padding: "9px 12px", color: "#111827", fontSize: "0.85rem", outline: "none", boxSizing: "border-box" };
  const labelStyle = { color: "#374151", fontSize: "0.75rem", fontWeight: 600, marginBottom: "5px", display: "block" };

  return (
    <div style={{ minHeight: "100vh", background: "#f9fafb", color: "#111827", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <style>{`
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: #f1f5f9; }
        ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
        .th-sort:hover { background: #f1f5f9 !important; cursor: pointer; }
        .data-row:hover td { background: #f8fafc !important; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spin { display: inline-block; animation: spin 1s linear infinite; }
      `}</style>

      {/* Modals */}
      {showDbPicker && <DatabasePickerModal onSelect={handleDbSelected} onClose={() => setShowDbPicker(false)} />}
      {pushProgress && <PushProgressModal {...pushProgress} done={!pushing} onClose={() => setPushProgress(null)} />}

      {/* Header */}
      <div style={{ background: "#fff", borderBottom: "1px solid #e5e7eb", padding: "14px 28px" }}>
        <div style={{ maxWidth: "1200px", margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div style={{ width: "34px", height: "34px", background: "#2563eb", borderRadius: "8px", display: "grid", placeItems: "center", color: "#fff", fontSize: "1rem", fontWeight: 700 }}>R</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: "1rem", color: "#111827" }}>RAM Engineering</div>
              <div style={{ color: "#9ca3af", fontSize: "0.7rem" }}>Order Form</div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: "7px", padding: "5px 11px" }}>
              <div style={{ width: "7px", height: "7px", borderRadius: "50%", background: "#2563eb" }} />
              <span style={{ color: "#1d4ed8", fontSize: "0.75rem", fontWeight: 500 }}>Notion connected</span>
            </div>
            <button onClick={() => setShowDbPicker(true)}
              style={{ background: "#fff", color: "#374151", border: "1px solid #d1d5db", borderRadius: "7px", padding: "5px 12px", fontSize: "0.75rem", cursor: "pointer", fontWeight: 500 }}>
              🗄 {targetDb ? (targetDb.title.length > 22 ? targetDb.title.slice(0, 22) + "…" : targetDb.title) : "Select database"}
            </button>
            {targetDb && (
              <a href={`https://notion.so/${targetDb.id.replace(/-/g, "")}`} target="_blank" rel="noopener noreferrer"
                style={{ background: "#fff", border: "1px solid #d1d5db", color: "#374151", borderRadius: "7px", padding: "5px 11px", fontSize: "0.75rem", textDecoration: "none", fontWeight: 500 }}>
                Open in Notion ↗
              </a>
            )}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "24px 28px" }}>

        {/* Notion status bar */}
        <div style={{ background: notionReady ? "#eff6ff" : "#f9fafb", border: `1px solid ${notionReady ? "#bfdbfe" : "#e5e7eb"}`, borderRadius: "12px", padding: "14px 18px", marginBottom: "16px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px" }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: "0.85rem", color: notionReady ? "#1d4ed8" : "#6b7280" }}>
              {notionReady ? `Syncing to "${targetDb.title}"` : "No database selected"}
            </div>
            <div style={{ color: "#9ca3af", fontSize: "0.72rem", marginTop: "2px" }}>
              {!targetDb ? <button onClick={() => setShowDbPicker(true)} style={{ background: "none", border: "none", color: "#2563eb", cursor: "pointer", fontSize: "inherit", padding: 0 }}>Choose a database →</button> : "Rows will be pushed as new pages."}
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <button onClick={() => setShowDbPicker(true)}
              style={{ background: "#fff", border: "1px solid #d1d5db", color: "#374151", borderRadius: "7px", padding: "6px 12px", fontSize: "0.75rem", cursor: "pointer", fontWeight: 500 }}>
              Change database
            </button>
            {notionReady && mergedData && (
              <button onClick={autoPushToNotion} disabled={pushing}
                style={{ background: pushing ? "#e5e7eb" : "#2563eb", color: pushing ? "#9ca3af" : "#fff", border: "none", borderRadius: "7px", padding: "6px 14px", fontWeight: 600, fontSize: "0.78rem", cursor: pushing ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: "5px" }}>
                {pushing ? <><span className="spin">↻</span> Sending…</> : "↑ Push to Notion"}
              </button>
            )}
          </div>
        </div>

        {/* Upload section */}
        <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: "14px", padding: "20px", marginBottom: "16px" }}>
          <div style={{ fontWeight: 600, fontSize: "0.9rem", color: "#111827", marginBottom: "4px" }}>Upload your data</div>
          <div style={{ color: "#9ca3af", fontSize: "0.78rem", marginBottom: "16px" }}>Drop a spreadsheet file or paste a Google Sheet link below.</div>

          {/* File drop zone */}
          <div style={{ marginBottom: "16px" }}>
            <label style={labelStyle}>File (.xlsx, .xls, .csv)</label>
            <DropZone label="Click or drag a file here" sublabel=".xlsx / .xls / .csv" accept=".csv,.xlsx,.xls" onFile={(f) => { setFile1(f); setUploadTimestamp(new Date()); }} file={file1} />
          </div>

          {/* Google Sheets */}
          <div style={{ marginBottom: "16px" }}>
            <label style={labelStyle}>Google Sheet link</label>
            <div style={{ background: "#fefce8", border: "1px solid #fde68a", borderRadius: "8px", padding: "10px 13px", marginBottom: "8px", fontSize: "0.78rem", color: "#92400e", lineHeight: 1.7 }}>
              Before pasting your link, go to <strong>File → Share → Share with others</strong> in Google Sheets and set access to <strong>"Anyone with the link" → Viewer</strong>. Otherwise the import will be blocked.
            </div>
            <input
              value={sheetUrl}
              onChange={(e) => setSheetUrl(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/..."
              style={{ ...inputStyle, borderColor: sheetUrl ? "#2563eb" : "#d1d5db" }}
            />
            {sheetUrl && !/spreadsheets\/d\//.test(sheetUrl) && (
              <div style={{ color: "#dc2626", fontSize: "0.72rem", marginTop: "4px" }}>⚠ That doesn't look like a valid Google Sheets URL.</div>
            )}
          </div>

          {/* Orderer + Project team */}
          <div style={{ display: "flex", gap: "12px", marginBottom: "16px", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: "160px" }}>
              <label style={labelStyle}>Your name</label>
              <input value={orderer} onChange={(e) => setOrderer(e.target.value)} placeholder="e.g. Jane Smith" style={inputStyle} />
            </div>
            <div style={{ flex: 1, minWidth: "160px" }}>
              <label style={labelStyle}>Project or team</label>
              <input value={projectTeam} onChange={(e) => setProjectTeam(e.target.value)} placeholder="e.g. Mechanical — Q2" style={inputStyle} />
            </div>
          </div>

          {uploadTimestamp && file1 && (
            <div style={{ color: "#2563eb", fontSize: "0.75rem", marginBottom: "12px" }}>
              File selected at {uploadTimestamp.toLocaleString()}
            </div>
          )}

          {error && (
            <div style={{ color: "#dc2626", fontSize: "0.78rem", padding: "8px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", marginBottom: "10px" }}>
              ⚠ {error}
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <button onClick={merge} disabled={loading}
              style={{ background: loading ? "#e5e7eb" : "#2563eb", color: loading ? "#9ca3af" : "#fff", border: "none", borderRadius: "9px", padding: "9px 22px", fontWeight: 600, fontSize: "0.85rem", cursor: loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: "6px" }}>
              {loading ? <><span className="spin">↻</span> Processing…</> : "Process file"}
            </button>
            {notionReady && mergedData && <span style={{ color: "#16a34a", fontSize: "0.75rem" }}>✓ Ready to push to Notion</span>}
          </div>
        </div>

        {/* Results */}
        {mergedData && (
          <>
            {/* Parse info */}
            {parseInfo.length > 0 && (
              <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "8px", padding: "8px 14px", marginBottom: "12px", display: "flex", gap: "16px", flexWrap: "wrap" }}>
                {parseInfo.map((info, i) => <span key={i} style={{ color: "#15803d", fontSize: "0.78rem" }}>{info}</span>)}
              </div>
            )}

            {/* Stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(130px,1fr))", gap: "10px", marginBottom: "14px" }}>
              {[
                { l: "Total rows",  v: mergedData.length, c: "#1d4ed8", bg: "#eff6ff" },
                { l: "Columns",     v: headers.length,    c: "#374151", bg: "#f9fafb" },
                totalQty !== null && { l: "Total qty",   v: totalQty.toLocaleString(), c: "#5b21b6", bg: "#f5f3ff" },
                totalRevenue !== null && { l: "Total value", v: `$${totalRevenue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, c: "#065f46", bg: "#f0fdf4" },
              ].filter(Boolean).map((s) => (
                <div key={s.l} style={{ background: s.bg, border: "1px solid #e5e7eb", borderRadius: "10px", padding: "12px 14px" }}>
                  <div style={{ color: s.c, fontSize: "1.1rem", fontWeight: 700 }}>{s.v}</div>
                  <div style={{ color: "#9ca3af", fontSize: "0.68rem", marginTop: "2px" }}>{s.l}</div>
                </div>
              ))}
            </div>

            {/* Column mapping display */}
            <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: "10px", padding: "12px 16px", marginBottom: "12px" }}>
              <div style={{ fontWeight: 600, fontSize: "0.78rem", color: "#374151", marginBottom: "8px" }}>
                Column types {columnMapping && <span style={{ color: "#2563eb", fontWeight: 400, marginLeft: "8px" }}>— Notion mapping applied</span>}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {headers.map((h) => {
                  const notionProp = columnMapping?.[h];
                  const notionPropType = notionProp && notionSchema?.[notionProp]?.type;
                  const nMeta = notionPropType ? NOTION_PROP_META[notionPropType] : null;
                  return (
                    <div key={h} style={{ display: "flex", alignItems: "center", gap: "4px", background: "#f3f4f6", border: "1px solid #e5e7eb", borderRadius: "6px", padding: "3px 9px" }}>
                      <span style={{ color: "#374151", fontSize: "0.75rem" }}>{h}</span>
                      {nMeta && (
                        <>
                          <span style={{ color: "#d1d5db", fontSize: "0.65rem" }}>→</span>
                          <span style={{ color: nMeta.color, fontSize: "0.65rem" }}>{nMeta.icon} {notionProp}</span>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Table */}
            <div style={{ overflowX: "auto", borderRadius: "10px", border: "1px solid #e5e7eb", marginBottom: "12px" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem", background: "#fff" }}>
                <thead>
                  <tr style={{ background: "#f9fafb" }}>
                    {displayHeaders.map((h) => (
                      <th key={h} className="th-sort" onClick={() => handleSort(h)}
                        style={{ padding: "10px 12px", textAlign: "left", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap", background: sortCol === h ? "#f1f5f9" : undefined, userSelect: "none" }}>
                        <span style={{ color: "#374151", fontSize: "0.8rem", fontWeight: 600 }}>
                          {h}{sortCol === h ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                        </span>
                      </th>
                    ))}
                    <th style={{ padding: "10px 12px", borderBottom: "1px solid #e5e7eb", color: "#9ca3af", fontSize: "0.7rem", fontWeight: 500 }}>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.slice(0, 500).map((row, i) => (
                    <tr key={i} className="data-row">
                      {displayHeaders.map((h) => (
                        <td key={h} style={{ padding: "8px 12px", borderBottom: "1px solid #f3f4f6", maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis" }}>
                          <Cell value={row[h]} type={colTypes[h]} />
                        </td>
                      ))}
                      <td style={{ padding: "8px 12px", borderBottom: "1px solid #f3f4f6", color: "#9ca3af", fontSize: "0.72rem", whiteSpace: "nowrap" }}>{row._source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {displayRows.length > 500 && <div style={{ textAlign: "center", color: "#9ca3af", fontSize: "0.75rem", marginBottom: "8px" }}>Showing 500 of {displayRows.length} rows</div>}

            <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <span style={{ color: "#9ca3af", fontSize: "0.75rem" }}>{mergedData.length} total rows</span>
              {notionReady ? (
                <button onClick={autoPushToNotion} disabled={pushing}
                  style={{ background: pushing ? "#e5e7eb" : "#2563eb", color: pushing ? "#9ca3af" : "#fff", border: "none", borderRadius: "8px", padding: "8px 16px", fontWeight: 600, fontSize: "0.8rem", cursor: pushing ? "not-allowed" : "pointer" }}>
                  ↑ Push to Notion
                </button>
              ) : (
                <button onClick={() => setShowDbPicker(true)}
                  style={{ background: "#fff", border: "1px solid #2563eb", color: "#2563eb", borderRadius: "8px", padding: "8px 16px", fontWeight: 600, fontSize: "0.8rem", cursor: "pointer" }}>
                  Select database to push
                </button>
              )}
            </div>
          </>
        )}

        {/* Empty state */}
        {!mergedData && (
          <div style={{ textAlign: "center", padding: "60px 20px", color: "#9ca3af" }}>
            <div style={{ fontSize: "2rem", marginBottom: "12px" }}>📋</div>
            <div style={{ fontWeight: 600, fontSize: "0.9rem", color: "#374151", marginBottom: "8px" }}>How it works</div>
            <div style={{ fontSize: "0.82rem", lineHeight: 2.2, maxWidth: "400px", margin: "0 auto", textAlign: "left" }}>
              <div>1. <span style={{ color: "#111827" }}>Upload a file or paste a Google Sheet link</span></div>
              <div>2. <span style={{ color: "#111827" }}>Enter your name and project team</span></div>
              <div>3. <span style={{ color: "#111827" }}>Click "Process file" — your data will appear here</span></div>
              <div>4. <span style={{ color: "#111827" }}>Click "Push to Notion" to send all rows</span></div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
