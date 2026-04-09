import { useState, useCallback, useRef, useEffect } from "react";
import * as XLSX from "xlsx";

// ─────────────────────────────────────────────────────────────────────────────
// NOTION PROXY HELPER
// All Notion API calls go through /.netlify/functions/notion
// to avoid CORS errors in the browser.
// ─────────────────────────────────────────────────────────────────────────────
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

// Fetch all databases the integration has access to
async function fetchNotionDatabases() {
  const data = await notionRequest({
    path: "/search",
    method: "POST",
    body: { filter: { value: "database", property: "object" }, page_size: 50 },
  });
  return data.results || [];
}

// Fetch properties schema for a specific database
async function fetchDatabaseSchema(databaseId) {
  const data = await notionRequest({ path: `/databases/${databaseId}` });
  return data.properties || {};
}

// Push a single row as a new Notion page in the database
async function createNotionPage(databaseId, properties) {
  return notionRequest({
    path: "/pages",
    method: "POST",
    body: { parent: { database_id: databaseId }, properties },
  });
}

// Build a Notion property value object from a raw cell value + Notion property type
function buildNotionProperty(value, propType) {
  const s = String(value ?? "").trim();
  if (!s) return null;

  switch (propType) {
    case "title":
      return { title: [{ text: { content: s } }] };
    case "rich_text":
      return { rich_text: [{ text: { content: s } }] };
    case "number": {
      const n = parseFloat(s.replace(/[^0-9.-]/g, ""));
      return isNaN(n) ? null : { number: n };
    }
    case "url":
      return /^https?:\/\//i.test(s) ? { url: s } : { url: `https://${s}` };
    case "email":
      return { email: s };
    case "phone_number":
      return { phone_number: s };
    case "checkbox":
      return { checkbox: s.toLowerCase() === "true" || s === "1" };
    case "select":
      return { select: { name: s } };
    case "multi_select":
      return { multi_select: s.split(",").map((v) => ({ name: v.trim() })) };
    case "date":
      return { date: { start: s } };
    default:
      return { rich_text: [{ text: { content: s } }] };
  }
}

// Format header names: URL stays all-caps, everything else gets first letter capitalized
function formatHeader(h) {
  if (h.toLowerCase() === "url") return "URL";
  return h.charAt(0).toUpperCase() + h.slice(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPE DETECTION (same as before — used for display only)
// ─────────────────────────────────────────────────────────────────────────────
const isUrl = (v) => {
  if (typeof v !== "string") return false;
  const s = v.trim();
  return (
    /^https?:\/\//i.test(s) ||
    /^www\./i.test(s) ||
    /^[a-z0-9-]+\.[a-z]{2,}(\/|$)/i.test(s)
  );
};
const isInteger = (v) => {
  const n = Number(v);
  return v !== "" && v != null && !isNaN(n) && Number.isInteger(n);
};
const isFloat = (v) => {
  const n = Number(v);
  return v !== "" && v != null && !isNaN(n) && !Number.isInteger(n);
};
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

// ─────────────────────────────────────────────────────────────────────────────
// VISUAL METADATA
// ─────────────────────────────────────────────────────────────────────────────
const COL_TYPE_META = {
  integer: { label: "Quantity",    color: "#7c3aed", icon: "#",  badge: "#ede9fe", badgeFg: "#a5b4fc" },
  float:   { label: "Price",       color: "#059669", icon: "$",  badge: "#d1fae5", badgeFg: "#6ee7b7" },
  url:     { label: "Link",        color: "#7EC8E3", icon: "↗",  badge: "#dbeafe", badgeFg: "#fcd34d" },
  text:    { label: "Text",        color: "#f472b6", icon: "T",  badge: "#fce7f3", badgeFg: "#f0abfc" },
  unknown: { label: "Other",       color: "#6b7280", icon: "?",  badge: "#1f2937", badgeFg: "#9ca3af" },
};

// Notion property type display info
const NOTION_PROP_META = {
  title:        { color: "#f472b6", icon: "★" },
  rich_text:    { color: "#6b7280", icon: "T" },
  number:       { color: "#059669", icon: "#" },
  url:          { color: "#7EC8E3", icon: "↗" },
  email:        { color: "#7c3aed", icon: "@" },
  phone_number: { color: "#c084fc", icon: "☎" },
  checkbox:     { color: "#059669", icon: "✓" },
  select:       { color: "#f59e0b", icon: "◉" },
  multi_select: { color: "#fb923c", icon: "⊕" },
  date:         { color: "#60a5fa", icon: "📅" },
  formula:      { color: "#475569", icon: "ƒ" },
  rollup:       { color: "#475569", icon: "⟳" },
  relation:     { color: "#475569", icon: "↔" },
};

// ─────────────────────────────────────────────────────────────────────────────
// FILE PARSER
// CSV files are read as text to preserve URLs and special characters.
// Excel files are read as ArrayBuffer via SheetJS.
// ─────────────────────────────────────────────────────────────────────────────
function parseCsvText(text) {
  // Robust CSV parser: handles quoted fields, embedded commas, newlines
  const rows = [];
  let row = [], field = "", inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
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
          // Read CSV as text to preserve URLs exactly
          raw = parseCsvText(e.target.result);
        } else {
          const uint8 = new Uint8Array(e.target.result);
          const wb = XLSX.read(uint8, { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        }
        const cleaned = raw.filter((r) => r.some((c) => String(c).trim() !== ""));
        if (!cleaned.length) {
          resolve({ name: file.name, headers: [], dataRows: [] });
          return;
        }
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
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    // CSV → text, Excel → ArrayBuffer
    if (isCsv) reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// UI COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
function DropZone({ label, sublabel, icon, accept, onFile, file }) {
  const [drag, setDrag] = useState(false);
  const ref = useRef();
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
      onClick={() => ref.current.click()}
      style={{ border: `2px dashed ${drag ? "#4B9CD3" : file ? "#34d399" : "#1f2937"}`, borderRadius: "14px", padding: "20px 16px", cursor: "pointer", background: drag ? "#EBF5FB" : file ? "#031a0e" : "#ffffff", transition: "all 0.2s", textAlign: "center", flex: 1, minWidth: 0 }}
    >
      <input ref={ref} type="file" accept={accept} style={{ display: "none" }} onChange={(e) => e.target.files[0] && onFile(e.target.files[0])} />
      <div style={{ fontSize: "1.6rem", marginBottom: "5px" }}>{icon}</div>
      <div style={{ color: file ? "#059669" : "#6b7280", fontSize: "0.875rem", fontFamily: "monospace", marginBottom: "2px" }}>
        {file ? `✓ ${file.name}` : label}
      </div>
      {sublabel && !file && <div style={{ color: "#6b7280", fontSize: "0.875rem" }}>{sublabel}</div>}
    </div>
  );
}

function Cell({ value, type }) {
  const s = String(value ?? "").trim();
  if (!s) return <span style={{ color: "#9ca3af" }}>—</span>;
  if (type === "url" || isUrl(s)) {
    const href = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    return <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: "#fcd34d", textDecoration: "none", borderBottom: "1px dashed #fcd34d44", fontSize: "0.875rem" }}>↗ {s.length > 28 ? s.slice(0, 28) + "…" : s}</a>;
  }
  if (type === "float") return <span style={{ color: "#059669", fontVariantNumeric: "tabular-nums" }}>${parseFloat(s).toFixed(2)}</span>;
  if (type === "integer") return <span style={{ color: "#7c3aed", fontVariantNumeric: "tabular-nums" }}>{parseInt(s).toLocaleString()}</span>;
  return <span style={{ color: "#111827" }}>{s}</span>;
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTION TOKEN SETUP MODAL
// ─────────────────────────────────────────────────────────────────────────────
function NotionSetupModal({ onSave, onClose }) {
  const [draft, setDraft] = useState(localStorage.getItem("notionToken") || "");

  const save = () => {
    const t = draft.trim();
    if (!t) return;
    localStorage.setItem("notionToken", t);
    onSave(t);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(249,250,251,0.96)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px" }}>
      <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "18px", padding: "28px", maxWidth: "540px", width: "100%" }}>
        <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: "1rem", color: "#7EC8E3", marginBottom: "6px" }}>Connect Notion</div>
        <div style={{ color: "#6b7280", fontSize: "0.85rem", lineHeight: 2, marginBottom: "20px" }}>
          You need a Notion Internal Integration token to push data to your database.<br />
          <strong style={{ color: "#6b7280" }}>Steps:</strong><br />
          1. Go to <a href="https://www.notion.so/my-integrations" target="_blank" rel="noopener noreferrer" style={{ color: "#fb923c" }}>notion.so/my-integrations</a><br />
          2. Click <strong style={{ color: "#6b7280" }}>+ New integration</strong> → give it a name → Submit<br />
          3. Copy the <strong style={{ color: "#6b7280" }}>Internal Integration Token</strong> (starts with <code style={{ color: "#fcd34d", background: "#1f2937", padding: "1px 5px", borderRadius: "4px" }}>secret_</code>)<br />
          4. Open your Notion database → click <strong style={{ color: "#6b7280" }}>⋯ Menu → Add connections</strong> → select your integration<br />
          5. Paste the token below
        </div>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="secret_xxxxxxxxxxxxxxxxxxxxxxxxx"
          style={{ width: "100%", background: "#f9fafb", border: "1px solid #d1d5db", borderRadius: "8px", padding: "10px 12px", color: "#111827", fontSize: "0.875rem", fontFamily: "monospace", marginBottom: "14px", outline: "none", boxSizing: "border-box" }}
        />
        <div style={{ display: "flex", gap: "10px" }}>
          <button onClick={save} style={{ background: "linear-gradient(135deg,#4B9CD3,#4B9CD3)", color: "#fff", border: "none", borderRadius: "8px", padding: "9px 20px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.875rem", cursor: "pointer" }}>
            SAVE & CONNECT
          </button>
          <button onClick={onClose} style={{ background: "transparent", border: "1px solid #d1d5db", color: "#6b7280", borderRadius: "8px", padding: "9px 20px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.875rem", cursor: "pointer" }}>
            CANCEL
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTION DATABASE PICKER MODAL
// ─────────────────────────────────────────────────────────────────────────────
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

  const confirm = () => {
    if (!selectedDb) return;
    onSelect(selectedDb);
  };

  const getDbTitle = (db) => {
    const t = db.title?.[0]?.plain_text;
    return t || "Untitled Database";
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(249,250,251,0.96)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px" }}>
      <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "20px", padding: "28px", maxWidth: "520px", width: "100%", maxHeight: "80vh", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
          <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: "1rem", color: "#7EC8E3" }}>Select a Database</div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "#6b7280", cursor: "pointer", fontSize: "1.2rem" }}>✕</button>
        </div>

        {loading && <div style={{ color: "#6b7280", fontSize: "0.85rem", textAlign: "center", padding: "30px" }}>Loading your databases…</div>}
        {error && <div style={{ color: "#f87171", fontSize: "0.82rem", padding: "8px" }}>⚠ {error}<br /><span style={{ color: "#6b7280" }}>Make sure your integration has been added to at least one database.</span></div>}

        {!loading && !error && (
          <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: "6px" }}>
            {databases.length === 0 && (
              <div style={{ color: "#6b7280", fontSize: "0.85rem", textAlign: "center", padding: "20px", lineHeight: 1.8 }}>
                No databases found.<br />
                Make sure you've added your integration to a database via<br />
                <strong style={{ color: "#6b7280" }}>⋯ Menu → Add connections</strong> in Notion.
              </div>
            )}
            {databases.map((db) => (
              <div key={db.id} onClick={() => setSelectedDb(db)}
                style={{ padding: "12px 14px", borderRadius: "10px", cursor: "pointer", background: selectedDb?.id === db.id ? "#EBF5FB" : "#f8fafc", border: `1px solid ${selectedDb?.id === db.id ? "#4B9CD3" : "#1f2937"}`, display: "flex", alignItems: "center", gap: "10px", transition: "all 0.15s" }}>
                <span style={{ fontSize: "1.1rem" }}>🗄</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: selectedDb?.id === db.id ? "#2563eb" : "#111827", fontSize: "0.875rem", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {getDbTitle(db)}
                  </div>
                  <div style={{ color: "#6b7280", fontSize: "0.875rem", marginTop: "2px", fontFamily: "monospace" }}>{db.id}</div>
                </div>
                {selectedDb?.id === db.id && <span style={{ color: "#4B9CD3", fontSize: "0.8rem" }}>✓</span>}
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: "20px", display: "flex", gap: "10px", justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ background: "transparent", border: "1px solid #d1d5db", color: "#6b7280", borderRadius: "8px", padding: "9px 18px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.85rem", cursor: "pointer" }}>Cancel</button>
          <button onClick={confirm} disabled={!selectedDb}
            style={{ background: !selectedDb ? "#e5e7eb" : "linear-gradient(135deg,#4B9CD3,#4B9CD3)", color: !selectedDb ? "#9ca3af" : "#fff", border: "none", borderRadius: "8px", padding: "9px 20px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.85rem", cursor: !selectedDb ? "not-allowed" : "pointer" }}>
            ✓ USE THIS DATABASE
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// COLUMN MAPPER MODAL
// Maps spreadsheet columns → Notion database properties
// ─────────────────────────────────────────────────────────────────────────────
function ColumnMapperModal({ spreadsheetHeaders, notionSchema, onConfirm, onClose }) {
  // Auto-suggest: try to match spreadsheet col names to notion property names
  const autoMap = () => {
    const mapping = {};
    spreadsheetHeaders.forEach((h) => {
      const lower = h.toLowerCase().trim();
      // Exact match first
      const exact = Object.keys(notionSchema).find((k) => k.toLowerCase() === lower);
      if (exact) { mapping[h] = exact; return; }
      // Timestamp column: always map to a Notion property named "Timestamp" (any case)
      if (lower === "timestamp") {
        const tsProp = Object.keys(notionSchema).find((k) => k.toLowerCase() === "timestamp");
        if (tsProp) { mapping[h] = tsProp; return; }
      }
      // For URL-like column headers, prefer Notion properties of type "url"
      const looksLikeUrl = /url|link|href|website|site/i.test(lower);
      if (looksLikeUrl) {
        const urlProp = Object.keys(notionSchema).find((k) => notionSchema[k].type === "url");
        if (urlProp) { mapping[h] = urlProp; return; }
      }
      // Partial match
      const partial = Object.keys(notionSchema).find(
        (k) => k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase())
      );
      if (partial) mapping[h] = partial;
    });
    return mapping;
  };

  const [mapping, setMapping] = useState(autoMap);

  // Editable properties only (formula/rollup/relation are read-only in Notion)
  const editableProps = Object.entries(notionSchema).filter(
    ([, p]) => !["formula", "rollup", "relation", "created_time", "last_edited_time", "created_by", "last_edited_by"].includes(p.type)
  );

  const setMap = (header, notionProp) => {
    setMapping((prev) => ({ ...prev, [header]: notionProp || undefined }));
  };

  const mappedCount = Object.values(mapping).filter(Boolean).length;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(249,250,251,0.96)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px" }}>
      <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "20px", padding: "28px", maxWidth: "640px", width: "100%", maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
          <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: "1rem", color: "#7EC8E3" }}>Map Columns to Notion</div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "#6b7280", cursor: "pointer", fontSize: "1.2rem" }}>✕</button>
        </div>

        <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: "7px" }}>
          {spreadsheetHeaders.map((h) => {
            const currentVal = mapping[h] || "";
            const notionProp = notionSchema[currentVal];
            const meta = NOTION_PROP_META[notionProp?.type] || { color: "#6b7280", icon: "?" };
            return (
              <div key={h} style={{ display: "flex", alignItems: "center", gap: "10px", background: "#f8fafc", borderRadius: "10px", padding: "10px 12px", border: `1px solid ${currentVal ? "#4B9CD320" : "#1f2937"}` }}>
                {/* Spreadsheet column */}
                <div style={{ flex: "0 0 180px", minWidth: 0 }}>
                  <div style={{ color: "#111827", fontSize: "0.875rem", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h}</div>
                  <div style={{ color: "#6b7280", fontSize: "0.875rem", marginTop: "1px" }}></div>
                </div>

                <div style={{ color: "#6b7280", fontSize: "0.8rem" }}>→</div>

                {/* Notion property selector */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <select
                    value={currentVal}
                    onChange={(e) => setMap(h, e.target.value)}
                    style={{ width: "100%", background: "#f9fafb", border: `1px solid ${currentVal ? "#4B9CD3" : "#d1d5db"}`, borderRadius: "7px", padding: "6px 10px", color: currentVal ? "#7EC8E3" : "#6b7280", fontSize: "0.85rem", fontFamily: "monospace", outline: "none", cursor: "pointer" }}
                  >
                    <option value="">Skip this column</option>
                    {editableProps.map(([name, prop]) => {
                      const m = NOTION_PROP_META[prop.type] || { icon: "?" };
                      return (
                        <option key={name} value={name}>
                          {m.icon} {name} ({prop.type})
                        </option>
                      );
                    })}
                  </select>
                  {/* Warn if a URL-like column is mapped to rich_text */}
                  {currentVal && notionProp?.type === "rich_text" && /url|link|href|website/i.test(h) && (
                    <div style={{ color: "#f59e0b", fontSize: "0.875rem", marginTop: "3px" }}>⚠ This looks like a URL column — consider mapping to a <strong>url</strong> property</div>
                  )}
                </div>

                {/* Type badge */}
                {notionProp && (
                  <div style={{ flexShrink: 0, background: meta.color + "18", border: `1px solid ${meta.color}30`, borderRadius: "6px", padding: "3px 7px", fontSize: "0.875rem", color: meta.color, fontFamily: "'Syne',sans-serif", fontWeight: 700, whiteSpace: "nowrap" }}>
                    {meta.icon} {notionProp.type}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: "18px", paddingTop: "14px", borderTop: "1px solid #e2e8f0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ color: "#6b7280", fontSize: "0.8rem" }}>{mappedCount} of {spreadsheetHeaders.length} columns mapped</span>
          <div style={{ display: "flex", gap: "10px" }}>
            <button onClick={onClose} style={{ background: "transparent", border: "1px solid #d1d5db", color: "#6b7280", borderRadius: "8px", padding: "9px 18px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.85rem", cursor: "pointer" }}>Cancel</button>
            <button onClick={() => onConfirm(mapping)} disabled={mappedCount === 0}
              style={{ background: mappedCount === 0 ? "#e5e7eb" : "linear-gradient(135deg,#4B9CD3,#4B9CD3)", color: mappedCount === 0 ? "#9ca3af" : "#fff", border: "none", borderRadius: "8px", padding: "9px 20px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.85rem", cursor: mappedCount === 0 ? "not-allowed" : "pointer" }}>
              ✓ CONFIRM MAPPING
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PUSH PROGRESS MODAL
// ─────────────────────────────────────────────────────────────────────────────
function PushProgressModal({ total, pushed, failed, onClose, done }) {
  const pct = total > 0 ? Math.round((pushed + failed) / total * 100) : 0;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(249,250,251,0.96)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px" }}>
      <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "18px", padding: "32px", maxWidth: "400px", width: "100%", textAlign: "center" }}>
        <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: "1rem", color: done ? "#34d399" : "#7EC8E3", marginBottom: "8px" }}>
          {done ? "All done!" : "Sending to Notion…"}
        </div>
        <div style={{ color: "#6b7280", fontSize: "0.82rem", marginBottom: "20px" }}>
          {pushed + failed} of {total} rows complete
        </div>

        {/* Progress bar */}
        <div style={{ background: "#e2e8f0", borderRadius: "4px", height: "6px", marginBottom: "16px", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: failed > 0 ? "linear-gradient(90deg,#4B9CD3,#ef4444)" : "linear-gradient(90deg,#4B9CD3,#7EC8E3)", borderRadius: "4px", transition: "width 0.3s ease" }} />
        </div>

        <div style={{ display: "flex", justifyContent: "center", gap: "20px", marginBottom: "20px" }}>
          <div>
            <div style={{ color: "#059669", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "1.2rem" }}>{pushed}</div>
            <div style={{ color: "#6b7280", fontSize: "0.875rem", letterSpacing: "0.3px" }}>Sent</div>
          </div>
          {failed > 0 && (
            <div>
              <div style={{ color: "#f87171", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "1.2rem" }}>{failed}</div>
              <div style={{ color: "#6b7280", fontSize: "0.875rem", letterSpacing: "0.3px" }}>FAILED</div>
            </div>
          )}
        </div>

        {done && (
          <button onClick={onClose} style={{ background: "linear-gradient(135deg,#4B9CD3,#4B9CD3)", color: "#fff", border: "none", borderRadius: "8px", padding: "9px 24px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.875rem", cursor: "pointer" }}>
            DONE
          </button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-MAP: matches spreadsheet headers to Notion properties by name
// ─────────────────────────────────────────────────────────────────────────────
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
    const partial = Object.keys(notionSchema).find(
      (k) => k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase())
    );
    if (partial) mapping[h] = partial;
  });
  return mapping;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  // Files — single drop zone only
  const [file1, setFile1] = useState(null);
  const [uploadTimestamp, setUploadTimestamp] = useState(null);

  // Google Sheets
  const [sheetUrl, setSheetUrl] = useState("");

  // Order metadata
  const [orderer, setOrderer] = useState("");
  const [projectTeam, setProjectTeam] = useState("");

  // Parsed / merged data
  const [mergedData, setMergedData] = useState(null);
  const [headers, setHeaders] = useState([]);
  const [colTypes, setColTypes] = useState({});
  const [parseInfo, setParseInfo] = useState([]);

  // Notion — database is hardcoded, no selection needed
  const [showDbPicker, setShowDbPicker]     = useState(false);
  const [targetDb, setTargetDb]             = useState({ id: "31a9b1412417803abaf5e164229a0d54", title: "Orders" });
  const [notionSchema, setNotionSchema]     = useState(null);
  const [columnMapping, setColumnMapping]   = useState(null);

  // Auto-load schema on mount so users never have to select a database manually
  useEffect(() => {
    fetchDatabaseSchema("31a9b1412417803abaf5e164229a0d54")
      .then((schema) => setNotionSchema(schema))
      .catch((e) => setError("Could not load Notion schema: " + e.message));
  }, []);

  // Push progress
  const [pushing, setPushing]         = useState(false);
  const [pushProgress, setPushProgress] = useState(null); // { total, pushed, failed }

  // UI
  const [sortCol, setSortCol]   = useState(null);
  const [sortDir, setSortDir]   = useState("asc");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);

  // ── Select Database ──
  const handleDbSelected = useCallback(async (db) => {
    const title = db.title?.[0]?.plain_text || "Untitled";
    setTargetDb({ id: db.id, title });
    setShowDbPicker(false);
    setColumnMapping(null);
    try {
      const schema = await fetchDatabaseSchema(db.id);
      setNotionSchema(schema);
    } catch (e) {
      setError("Could not load database schema: " + e.message);
    }
  }, []);

  // ── Convert Google Sheets URL → CSV export URL ──
  const toSheetCsvUrl = (url) => {
    const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!idMatch) return null;
    const id = idMatch[1];
    const gidMatch = url.match(/[#&?]gid=(\d+)/);
    const gid = gidMatch ? gidMatch[1] : "0";
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  };

  // ── Parse & Merge ──
  const merge = useCallback(async () => {
    const hasFile = !!file1;
    const hasUrl  = sheetUrl.trim().length > 0;

    if (!hasFile && !hasUrl) {
      setError("Upload a file or paste a Google Sheet link first.");
      return;
    }
    if (hasUrl && !/spreadsheets\/d\//.test(sheetUrl)) {
      setError("That doesn't look like a valid Google Sheets URL.");
      return;
    }

    setLoading(true); setError(null); setColumnMapping(null);
    try {
      let r1;
      let sourceName;

      if (hasUrl) {
        // Fetch Google Sheet as CSV
        const csvUrl = toSheetCsvUrl(sheetUrl.trim());
        if (!csvUrl) throw new Error("Could not parse Google Sheets URL.");
        const res = await fetch(csvUrl);
        if (!res.ok) throw new Error(`Could not fetch sheet (${res.status}). Make sure it is shared as "Anyone with the link can view".`);
        const text = await res.text();
        const raw = parseCsvText(text);
        const cleaned = raw.filter((row) => row.some((c) => String(c).trim() !== ""));
        if (!cleaned.length) throw new Error("Sheet appears to be empty.");
        const role = detectFirstRowRole(cleaned);
        let headers, dataRows;
        if (role === "header") {
          headers = cleaned[0].map((h, i) => formatHeader(String(h ?? "").trim() || `Col ${i + 1}`));
          dataRows = cleaned.slice(1);
        } else {
          headers = cleaned[0].map((_, i) => `Col ${i + 1}`);
          dataRows = cleaned;
        }
        sourceName = "Google Sheet";
        r1 = { name: sourceName, headers, dataRows };
      } else {
        // Parse uploaded file (xlsx, xls, csv)
        r1 = await parseFile(file1);
        sourceName = file1.name;
      }

      // Include "Spreadsheet Link" column only when a Google Sheet URL was used
      const hasSheetLink = hasUrl && sheetUrl.trim();
      const hdrs = [
        ...r1.headers,
        ...(hasSheetLink ? ["Spreadsheet Link"] : []),
        "Timestamp", "Orderer", "Project Team",
      ];
      const ts = uploadTimestamp ? uploadTimestamp.toLocaleString() : new Date().toLocaleString();

      // Build a clean share URL (strip /export params so it opens the sheet nicely)
      const cleanSheetUrl = hasSheetLink
        ? sheetUrl.trim().split("/export")[0].replace(/\/(edit|pub|view).*$/, "")
        : "";

      const rows1 = r1.dataRows
        .filter((row) => row.some((c) => c !== ""))
        .map((row) => {
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
    } catch (e) {
      setError("Parse error: " + e.message);
    }
    setLoading(false);
  }, [file1, sheetUrl, uploadTimestamp, orderer, projectTeam]);

  // ── Push rows to Notion ──
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
        const slPropName =
          notionSchema["Spreadsheet Link"] ? "Spreadsheet Link" :
          Object.keys(notionSchema).find((k) => k.toLowerCase() === "spreadsheet link");
        if (slPropName && notionSchema[slPropName]) {
          const built = buildNotionProperty(slValue, notionSchema[slPropName].type || "url");
          if (built) properties[slPropName] = built;
        }
      }
      try {
        await createNotionPage(targetDb.id, properties);
        pushed++;
      } catch {
        failed++;
      }
      setPushProgress({ total: mergedData.length, pushed, failed });
    }

    setPushing(false);
  }, [mergedData, targetDb, notionSchema]);

  // ── Auto-map & push directly (no mapper modal) ──
  const autoPushToNotion = useCallback(async () => {
    if (!targetDb) { setShowDbPicker(true); return; }
    let schema = notionSchema;
    if (!schema) {
      try {
        schema = await fetchDatabaseSchema(targetDb.id);
        setNotionSchema(schema);
      } catch (e) {
        setError("Could not load schema: " + e.message);
        return;
      }
    }
    const headersToMap = headers.filter((h) => h !== "Spreadsheet Link");
    const mapping = buildAutoMap(headersToMap, schema);
    await pushToNotion(mapping);
  }, [targetDb, notionSchema, headers, pushToNotion]);

  // ── Sort ──
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

  // Stats
  const floatCols = headers.filter((h) => colTypes[h] === "float");
  const intCols   = headers.filter((h) => colTypes[h] === "integer");
  const totalRevenue = mergedData && floatCols[0] ? mergedData.reduce((s, r) => s + (parseFloat(r[floatCols[0]]) || 0), 0) : null;
  const totalQty     = mergedData && intCols[0] ? mergedData.reduce((s, r) => s + (parseInt(r[intCols[0]]) || 0), 0) : null;

  const notionReady = !!targetDb && !!notionSchema;

  // Hidden meta columns — submitted to Notion but not shown in the preview table
  const META_COLS = ["Orderer", "Project Team", "Timestamp", "Spreadsheet Link"];
  const displayHeaders = headers.filter((h) => !META_COLS.includes(h));

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: "#f5f7fa", color: "#111827", fontFamily: "'Inter',system-ui,sans-serif,'Courier New',monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@600;700;800&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: #ffffff; }
        ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
        .th-sort:hover { background: #e2e8f0 !important; cursor: pointer; }
        .data-row:hover td { background: #f1f5f9 !important; }
        .tab { background: none; border: none; cursor: pointer; padding: 10px 16px; font-family: 'Syne',sans-serif; font-size: 0.8rem; font-weight: 700; letter-spacing: 0.3px; color: #6b7280; border-bottom: 2px solid transparent; transition: all 0.2s; }
        .tab.on { color: #2563eb; border-bottom-color: #4B9CD3; }
        .tab:hover:not(.on) { color: #9ca3af; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spin { display: inline-block; animation: spin 1s linear infinite; }
        @keyframes slide-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .row-anim td { animation: slide-in 0.3s ease forwards; }
        select option { background: #ffffff; }
      `}</style>

      {/* Modals */}
      {showDbPicker && <DatabasePickerModal onSelect={handleDbSelected} onClose={() => setShowDbPicker(false)} />}
      {pushProgress && (
        <PushProgressModal
          {...pushProgress}
          done={!pushing}
          onClose={() => setPushProgress(null)}
        />
      )}

      {/* ── HEADER ── */}
      <div style={{ background: "#ffffff", borderBottom: "1px solid #e2e8f0", padding: "14px 26px" }}>
        <div style={{ maxWidth: "1440px", margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div style={{ width: "30px", height: "30px", background: "linear-gradient(135deg,#4B9CD3,#7EC8E3)", borderRadius: "7px", display: "grid", placeItems: "center", fontSize: "0.9rem" }}>⬡</div>
            <div>
              <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: "1rem", letterSpacing: "-0.3px", color: "#111827" }}>
                R.A.M ENGINEERING
              </div>
              <div style={{ color: "#6b7280", fontSize: "0.82rem", letterSpacing: "0.5px" }}>Order Form</div>
            </div>
          </div>

          {/* Notion database selector */}
          <div style={{ display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "5px", background: "#EBF5FB", border: "1px solid #93c5fd", borderRadius: "7px", padding: "5px 10px" }}>
              <div style={{ width: "5px", height: "5px", borderRadius: "50%", background: "#4B9CD3", boxShadow: "0 0 5px #4B9CD3" }} />
              <span style={{ color: "#7EC8E3", fontSize: "0.8rem" }}>Connected</span>
            </div>
            <button onClick={() => setShowDbPicker(true)}
              style={{ background: "linear-gradient(135deg,#EBF5FB,#EBF5FB)", color: "#7EC8E3", border: "1px solid #4B9CD340", borderRadius: "7px", padding: "5px 11px", fontSize: "0.8rem", cursor: "pointer", fontFamily: "'Syne',sans-serif", fontWeight: 700 }}>
              📋 {targetDb ? targetDb.title.length > 20 ? targetDb.title.slice(0, 20) + "…" : targetDb.title : "Choose Database"}
            </button>
            {targetDb && (
              <a href={`https://notion.so/${targetDb.id.replace(/-/g, "")}`} target="_blank" rel="noopener noreferrer"
                style={{ background: "transparent", border: "1px solid #4B9CD330", color: "#4B9CD3", borderRadius: "7px", padding: "5px 10px", fontSize: "0.78rem", textDecoration: "none", fontFamily: "'Syne',sans-serif", fontWeight: 700 }}>
                ↗ VIEW DB
              </a>
            )}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: "1440px", margin: "0 auto", padding: "18px 26px" }}>

        {/* ── NOTION STATUS PANEL ── */}
        <div style={{ background: notionReady ? "#EBF5FB" : "#f9fafb", border: `1px solid ${notionReady ? "#93c5fd" : "#e2e8f0"}`, borderRadius: "14px", padding: "14px 18px", marginBottom: "14px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ fontSize: "1.2rem" }}>⬡</span>
              <div>
                <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.82rem", color: notionReady ? "#7EC8E3" : "#6b7280", letterSpacing: "1px" }}>
                  {notionReady ? "Connected" : "Notion Sync"}
                </div>
                <div style={{ color: "#6b7280", fontSize: "0.875rem", marginTop: "1px" }}>
                  {!targetDb && (
                    <span>Connected · <button onClick={() => setShowDbPicker(true)} style={{ background: "none", border: "none", color: "#4B9CD3", cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", padding: 0, textDecoration: "underline" }}>Select a database ↗</button></span>
                  )}
                  {notionReady && (
                    <>Pushing to <strong style={{ color: "#7EC8E3" }}>"{targetDb.title}"</strong></>
                  )}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: "7px", alignItems: "center" }}>
              {targetDb && (
                <button onClick={() => setShowDbPicker(true)}
                  style={{ background: "transparent", border: "1px solid #4B9CD340", color: "#4B9CD3", borderRadius: "7px", padding: "6px 12px", fontSize: "0.78rem", cursor: "pointer", fontFamily: "'Syne',sans-serif", fontWeight: 700 }}>
                  Change
                </button>
              )}
              {notionReady && mergedData && (
                <button onClick={autoPushToNotion} disabled={pushing}
                  style={{ background: pushing ? "#e5e7eb" : "linear-gradient(135deg,#4B9CD3,#4B9CD3)", color: pushing ? "#9ca3af" : "#fff", border: "none", borderRadius: "7px", padding: "6px 14px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.8rem", cursor: pushing ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: "5px" }}>
                  {pushing ? <><span className="spin">↻</span> Sending…</> : "Send to Notion"}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ── UPLOAD ── */}
        <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "16px", padding: "16px", marginBottom: "14px" }}>
          <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.875rem", letterSpacing: "0.5px", color: "#6b7280", marginBottom: "10px" }}>Upload a File</div>

          {/* Single drop zone */}
          <div style={{ marginBottom: "12px" }}>
            <DropZone label="Drop your file here" sublabel=".xlsx / .xls / .csv" icon="📗" accept=".csv,.xlsx,.xls" onFile={(f) => { setFile1(f); setUploadTimestamp(new Date()); }} file={file1} />
          </div>

          {/* Google Sheets section */}
          <div style={{ marginBottom: "12px" }}>
            <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.875rem", letterSpacing: "0.5px", color: "#6b7280", marginBottom: "8px" }}>Or paste a Google Sheet link</div>

            {/* Tip box */}
            <div style={{ background: "#EBF5FB", border: "1px solid #93c5fd", borderRadius: "9px", padding: "9px 13px", marginBottom: "9px", display: "flex", alignItems: "flex-start", gap: "8px" }}>
              <span style={{ fontSize: "0.85rem", flexShrink: 0 }}>💡</span>
              <div style={{ fontSize: "0.78rem", color: "#374151", lineHeight: 1.8 }}>
                Before pasting your link, open your Google Sheet and go to{" "}
                <strong style={{ color: "#111827" }}>File → Share → Share with others</strong>, then set access to{" "}
                <strong style={{ color: "#059669" }}>"Anyone with the link" → Viewer</strong>. Otherwise the import will be blocked.
              </div>
            </div>

            {/* URL input */}
            <input
              value={sheetUrl}
              onChange={(e) => setSheetUrl(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/..."
              style={{ width: "100%", background: "#f9fafb", border: `1px solid ${sheetUrl ? "#4B9CD3" : "#374151"}`, borderRadius: "8px", padding: "9px 12px", color: "#111827", fontSize: "0.875rem", fontFamily: "monospace", outline: "none", boxSizing: "border-box", transition: "border-color 0.2s" }}
            />
            {sheetUrl && !/spreadsheets\/d\//.test(sheetUrl) && (
              <div style={{ color: "#f87171", fontSize: "0.875rem", marginTop: "4px" }}>⚠ That doesn't look like a valid Google Sheets URL</div>
            )}
          </div>

          {/* Orderer + Project Team */}
          <div style={{ display: "flex", gap: "10px", marginBottom: "12px", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: "180px" }}>
              <div style={{ color: "#6b7280", fontSize: "0.875rem", letterSpacing: "0.3px", fontFamily: "'Syne',sans-serif", fontWeight: 700, marginBottom: "5px" }}>Submitted by</div>
              <input
                value={orderer}
                onChange={(e) => setOrderer(e.target.value)}
                placeholder="Your name"
                style={{ width: "100%", background: "#f9fafb", border: "1px solid #d1d5db", borderRadius: "8px", padding: "8px 12px", color: "#111827", fontSize: "0.875rem", fontFamily: "monospace", outline: "none", boxSizing: "border-box" }}
              />
            </div>
            <div style={{ flex: 1, minWidth: "180px" }}>
              <div style={{ color: "#6b7280", fontSize: "0.875rem", letterSpacing: "0.3px", fontFamily: "'Syne',sans-serif", fontWeight: 700, marginBottom: "5px" }}>Project / Team</div>
              <input
                value={projectTeam}
                onChange={(e) => setProjectTeam(e.target.value)}
                placeholder="Team or project name"
                style={{ width: "100%", background: "#f9fafb", border: "1px solid #d1d5db", borderRadius: "8px", padding: "8px 12px", color: "#111827", fontSize: "0.875rem", fontFamily: "monospace", outline: "none", boxSizing: "border-box" }}
              />
            </div>
          </div>

          {/* Timestamp display */}
          {uploadTimestamp && file1 && (
            <div style={{ color: "#4B9CD3", fontSize: "0.875rem", marginBottom: "10px", fontFamily: "monospace" }}>
              🕐 File selected: {uploadTimestamp.toLocaleString()}
            </div>
          )}

          {error && <div style={{ color: "#dc2626", fontSize: "0.82rem", padding: "8px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "7px", marginBottom: "8px" }}>⚠ {error}</div>}
          <div style={{ display: "flex", alignItems: "center", gap: "9px", flexWrap: "wrap" }}>
            <button onClick={merge} disabled={loading}
              style={{ background: loading ? "#e5e7eb" : "linear-gradient(135deg,#4B9CD3,#7EC8E3)", color: loading ? "#9ca3af" : "#fff", border: "none", borderRadius: "9px", padding: "8px 20px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.875rem", letterSpacing: "0.3px", cursor: loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: "5px" }}>
              {loading ? <><span className="spin">↻</span> Processing…</> : "Process"}
            </button>
            {notionReady && mergedData && <span style={{ color: "#059669", fontSize: "0.875rem" }}>Ready to send to Notion ✓</span>}
          </div>
        </div>

        {/* ── RESULTS ── */}
        {mergedData && (
          <>
            {/* Parse info */}
            {parseInfo.length > 0 && (
              <div style={{ background: "#f0fdf4", border: "1px solid #34d39918", borderRadius: "8px", padding: "7px 13px", marginBottom: "10px", display: "flex", gap: "14px", flexWrap: "wrap" }}>
                <span style={{ color: "#6b7280", fontSize: "0.875rem", letterSpacing: "0.3px", fontFamily: "'Syne',sans-serif", fontWeight: 700, alignSelf: "center" }}>Loaded</span>
                {parseInfo.map((info, i) => <span key={i} style={{ color: "#059669", fontSize: "0.78rem", fontFamily: "monospace" }}>{info}</span>)}
              </div>
            )}

            {/* Stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(132px,1fr))", gap: "8px", marginBottom: "11px" }}>
              {[
                { l: "Rows",  v: mergedData.length, c: "#4B9CD3" },
                { l: "Columns",     v: headers.length,    c: "#7EC8E3" },
                totalQty !== null && { l: "Total Qty",   v: totalQty.toLocaleString(), c: "#a5b4fc" },
                totalRevenue !== null && { l: "Total Value", v: `$${totalRevenue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, c: "#6ee7b7" },
              ].filter(Boolean).map((s) => (
                <div key={s.l} style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "11px" }}>
                  <div style={{ color: s.c, fontSize: "1.05rem", fontWeight: 700, fontFamily: "'Syne',sans-serif" }}>{s.v}</div>
                  <div style={{ color: "#9ca3af", fontSize: "0.875rem", letterSpacing: "0.3px", marginTop: "2px" }}>{s.l}</div>
                </div>
              ))}
            </div>

            {/* Column mapping display */}
            <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "11px", padding: "10px 14px", marginBottom: "10px" }}>
              <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.875rem", letterSpacing: "0.5px", color: "#6b7280", marginBottom: "7px" }}>
                Column Summary {columnMapping && <span style={{ color: "#4B9CD3", marginLeft: "10px" }}>→ Mapped to Notion</span>}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
                {headers.map((h) => {
                  const meta = COL_TYPE_META[colTypes[h]] || COL_TYPE_META.unknown;
                  const notionProp = columnMapping?.[h];
                  const notionPropType = notionProp && notionSchema?.[notionProp]?.type;
                  const nMeta = notionPropType ? NOTION_PROP_META[notionPropType] : null;
                  return (
                    <div key={h} style={{ display: "flex", alignItems: "center", gap: "4px", background: meta.badge, border: `1px solid ${meta.color}28`, borderRadius: "6px", padding: "3px 7px" }}>
                      <span style={{ color: meta.color, fontSize: "0.875rem", fontWeight: 700 }}>{meta.icon}</span>
                      <span style={{ color: "#6b7280", fontSize: "0.8rem" }}>{h}</span>
                      {nMeta && (
                        <>
                          <span style={{ color: "#6b7280", fontSize: "0.875rem" }}>→</span>
                          <span style={{ color: nMeta.color, fontSize: "0.875rem" }}>{nMeta.icon} {notionProp}</span>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Tabs */}
            <div style={{ borderBottom: "1px solid #e2e8f0", marginBottom: "11px" }}>
              <button className={`tab on`}>Data Preview</button>
            </div>

            {/* Table */}
            <>
                <div style={{ overflowX: "auto", borderRadius: "11px", border: "1px solid #e2e8f0" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
                    <thead>
                      <tr style={{ background: "#f8fafc" }}>
                        {displayHeaders.map((h) => {
                          const meta = COL_TYPE_META[colTypes[h]] || COL_TYPE_META.unknown;
                          return (
                            <th key={h} className="th-sort" onClick={() => handleSort(h)}
                              style={{ padding: "9px 11px", textAlign: "left", borderBottom: "1px solid #e2e8f0", whiteSpace: "nowrap", background: sortCol === h ? "#e2e8f0" : undefined, userSelect: "none" }}>
                              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                <span style={{ color: meta.color, fontSize: "0.82rem", letterSpacing: "1px", fontFamily: "'Syne',sans-serif", fontWeight: 700 }}>{meta.icon} {meta.label}</span>
                                <span style={{ color: "#6b7280", fontSize: "0.8rem", fontWeight: 500 }}>{h}{sortCol === h ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</span>
                              </div>
                            </th>
                          );
                        })}
                        <th style={{ padding: "9px 11px", borderBottom: "1px solid #e2e8f0", color: "#9ca3af", fontFamily: "'Syne',sans-serif", fontSize: "0.875rem", letterSpacing: "0.3px" }}>SOURCE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayRows.slice(0, 500).map((row, i) => (
                        <tr key={i} className="data-row row-anim">
                          {displayHeaders.map((h) => (
                            <td key={h} style={{ padding: "7px 11px", borderBottom: "1px solid #f8fafc", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis" }}>
                              <Cell value={row[h]} type={colTypes[h]} />
                            </td>
                          ))}
                          <td style={{ padding: "7px 11px", borderBottom: "1px solid #f8fafc", color: "#6b7280", fontSize: "0.875rem", whiteSpace: "nowrap" }}>{row._source}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {displayRows.length > 500 && <div style={{ textAlign: "center", color: "#6b7280", fontSize: "0.78rem", marginTop: "6px" }}>Showing 500 of {displayRows.length} rows</div>}

                <div style={{ marginTop: "11px", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <span style={{ color: "#9ca3af", fontSize: "0.875rem" }}>{mergedData.length} rows</span>
                  {notionReady && (
                    <button onClick={autoPushToNotion} disabled={pushing}
                      style={{ background: pushing ? "#e5e7eb" : "linear-gradient(135deg,#4B9CD3,#4B9CD3)", color: pushing ? "#9ca3af" : "#fff", border: "none", borderRadius: "8px", padding: "7px 14px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.82rem", cursor: pushing ? "not-allowed" : "pointer" }}>
                      Send to Notion
                    </button>
                  )}
                  {!notionReady && (
                    <button onClick={() => setShowDbPicker(true)}
                      style={{ background: "transparent", border: "1px solid #4B9CD340", color: "#4B9CD3", borderRadius: "8px", padding: "7px 14px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.82rem", cursor: "pointer" }}>
                      Choose a database to send
                    </button>
                  )}
                </div>
            </>
          </>
        )}

        {/* Empty state */}
        {!mergedData && (
          <div style={{ textAlign: "center", padding: "48px 20px", color: "#9ca3af" }}>
            <div style={{ fontSize: "1.9rem", marginBottom: "10px", opacity: 0.35 }}>⬡</div>
            <div style={{ fontFamily: "'Syne',sans-serif", fontSize: "0.875rem", letterSpacing: "0.5px", marginBottom: "14px" }}>Get started</div>
            <div style={{ color: "#9ca3af", fontSize: "0.64rem", lineHeight: 2.3, maxWidth: "460px", margin: "0 auto", textAlign: "left" }}>
              <div>① <span style={{ color: "#4B9CD3" }}>Drop a file (.xlsx / .xls / .csv)</span> or paste a Google Sheet link</div>
              <div>② <span style={{ color: "#7EC8E3" }}>Enter orderer + project team</span> → saved with every row</div>
              <div>③ <span style={{ color: "#059669" }}>Process</span> → timestamp auto-captured</div>
              <div>④ <span style={{ color: "#f472b6" }}>Push</span> → rows become pages in Notion</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
