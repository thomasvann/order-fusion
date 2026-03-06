import { useState, useCallback, useRef, useEffect } from "react";
import * as XLSX from "xlsx";

// ─────────────────────────────────────────────────────────────────────────────
// NOTION PROXY HELPER
// All Notion API calls go through /.netlify/functions/notion
// to avoid CORS errors in the browser.
// ─────────────────────────────────────────────────────────────────────────────
async function notionRequest({ path, method = "GET", body }) {
  const res = await fetch("/.netlify/functions/notion", {
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
const isUrl = (v) =>
  typeof v === "string" &&
  (/^(https?:\/\/|www\.)/i.test(v.trim()) || /\.[a-z]{2,}\//i.test(v.trim()));
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
    if (bnr > 0.5) bs++;
    if (bur > 0.5) bs++;
  }
  return bs > 0 && fs / bs > 0.5 ? "data" : "header";
}

// ─────────────────────────────────────────────────────────────────────────────
// VISUAL METADATA
// ─────────────────────────────────────────────────────────────────────────────
const COL_TYPE_META = {
  integer: { label: "Quantity",    color: "#818cf8", icon: "#",  badge: "#1e1b4b", badgeFg: "#a5b4fc" },
  float:   { label: "Price",       color: "#34d399", icon: "$",  badge: "#052e16", badgeFg: "#6ee7b7" },
  url:     { label: "Link",        color: "#7EC8E3", icon: "↗",  badge: "#451a03", badgeFg: "#fcd34d" },
  text:    { label: "Text",        color: "#f472b6", icon: "T",  badge: "#4a044e", badgeFg: "#f0abfc" },
  unknown: { label: "Other",       color: "#6b7280", icon: "?",  badge: "#1f2937", badgeFg: "#9ca3af" },
};

// Notion property type display info
const NOTION_PROP_META = {
  title:        { color: "#f472b6", icon: "★" },
  rich_text:    { color: "#e2e8f0", icon: "T" },
  number:       { color: "#34d399", icon: "#" },
  url:          { color: "#7EC8E3", icon: "↗" },
  email:        { color: "#818cf8", icon: "@" },
  phone_number: { color: "#c084fc", icon: "☎" },
  checkbox:     { color: "#6ee7b7", icon: "✓" },
  select:       { color: "#f59e0b", icon: "◉" },
  multi_select: { color: "#fb923c", icon: "⊕" },
  date:         { color: "#60a5fa", icon: "📅" },
  formula:      { color: "#475569", icon: "ƒ" },
  rollup:       { color: "#475569", icon: "⟳" },
  relation:     { color: "#475569", icon: "↔" },
};

// ─────────────────────────────────────────────────────────────────────────────
// FILE PARSER
// ─────────────────────────────────────────────────────────────────────────────
function parseFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const uint8 = new Uint8Array(e.target.result);
        const wb = XLSX.read(uint8, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        const cleaned = raw.filter((r) => r.some((c) => c !== ""));
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
    reader.readAsArrayBuffer(file);
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
      style={{ border: `2px dashed ${drag ? "#4B9CD3" : file ? "#34d399" : "#1f2937"}`, borderRadius: "14px", padding: "20px 16px", cursor: "pointer", background: drag ? "#001B44" : file ? "#031a0e" : "#0b0f1a", transition: "all 0.2s", textAlign: "center", flex: 1, minWidth: 0 }}
    >
      <input ref={ref} type="file" accept={accept} style={{ display: "none" }} onChange={(e) => e.target.files[0] && onFile(e.target.files[0])} />
      <div style={{ fontSize: "1.6rem", marginBottom: "5px" }}>{icon}</div>
      <div style={{ color: file ? "#34d399" : "#9ca3af", fontSize: "0.73rem", fontFamily: "monospace", marginBottom: "2px" }}>
        {file ? `✓ ${file.name}` : label}
      </div>
      {sublabel && !file && <div style={{ color: "#374151", fontSize: "0.58rem" }}>{sublabel}</div>}
    </div>
  );
}

function Cell({ value, type }) {
  const s = String(value ?? "").trim();
  if (!s) return <span style={{ color: "#1f2937" }}>—</span>;
  if (type === "url" || isUrl(s)) {
    const href = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    return <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: "#fcd34d", textDecoration: "none", borderBottom: "1px dashed #fcd34d44", fontSize: "0.7rem" }}>↗ {s.length > 28 ? s.slice(0, 28) + "…" : s}</a>;
  }
  if (type === "float") return <span style={{ color: "#6ee7b7", fontVariantNumeric: "tabular-nums" }}>${parseFloat(s).toFixed(2)}</span>;
  if (type === "integer") return <span style={{ color: "#a5b4fc", fontVariantNumeric: "tabular-nums" }}>{parseInt(s).toLocaleString()}</span>;
  return <span style={{ color: "#f9fafb" }}>{s}</span>;
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
    <div style={{ position: "fixed", inset: 0, background: "#040810ee", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px" }}>
      <div style={{ background: "#0b0f1a", border: "1px solid #1f2937", borderRadius: "18px", padding: "28px", maxWidth: "540px", width: "100%" }}>
        <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: "1rem", color: "#7EC8E3", marginBottom: "6px" }}>Connect Notion</div>
        <div style={{ color: "#6b7280", fontSize: "0.68rem", lineHeight: 2, marginBottom: "20px" }}>
          You need a Notion Internal Integration token to push data to your database.<br />
          <strong style={{ color: "#9ca3af" }}>Steps:</strong><br />
          1. Go to <a href="https://www.notion.so/my-integrations" target="_blank" rel="noopener noreferrer" style={{ color: "#fb923c" }}>notion.so/my-integrations</a><br />
          2. Click <strong style={{ color: "#d1d5db" }}>+ New integration</strong> → give it a name → Submit<br />
          3. Copy the <strong style={{ color: "#d1d5db" }}>Internal Integration Token</strong> (starts with <code style={{ color: "#fcd34d", background: "#1f2937", padding: "1px 5px", borderRadius: "4px" }}>secret_</code>)<br />
          4. Open your Notion database → click <strong style={{ color: "#d1d5db" }}>⋯ Menu → Add connections</strong> → select your integration<br />
          5. Paste the token below
        </div>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="secret_xxxxxxxxxxxxxxxxxxxxxxxxx"
          style={{ width: "100%", background: "#04060f", border: "1px solid #374151", borderRadius: "8px", padding: "10px 12px", color: "#f9fafb", fontSize: "0.73rem", fontFamily: "monospace", marginBottom: "14px", outline: "none", boxSizing: "border-box" }}
        />
        <div style={{ display: "flex", gap: "10px" }}>
          <button onClick={save} style={{ background: "linear-gradient(135deg,#4B9CD3,#4B9CD3)", color: "#fff", border: "none", borderRadius: "8px", padding: "9px 20px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.7rem", cursor: "pointer" }}>
            SAVE & CONNECT
          </button>
          <button onClick={onClose} style={{ background: "transparent", border: "1px solid #374151", color: "#6b7280", borderRadius: "8px", padding: "9px 20px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.7rem", cursor: "pointer" }}>
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
  }, [token]);

  const confirm = () => {
    if (!selectedDb) return;
    onSelect(selectedDb);
  };

  const getDbTitle = (db) => {
    const t = db.title?.[0]?.plain_text;
    return t || "Untitled Database";
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#040810ee", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px" }}>
      <div style={{ background: "#0b0f1a", border: "1px solid #1f2937", borderRadius: "20px", padding: "28px", maxWidth: "520px", width: "100%", maxHeight: "80vh", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
          <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: "1rem", color: "#7EC8E3" }}>Select Notion Database</div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "#6b7280", cursor: "pointer", fontSize: "1.2rem" }}>✕</button>
        </div>

        {loading && <div style={{ color: "#6b7280", fontSize: "0.68rem", textAlign: "center", padding: "30px" }}>Loading your databases…</div>}
        {error && <div style={{ color: "#f87171", fontSize: "0.65rem", padding: "8px" }}>⚠ {error}<br /><span style={{ color: "#6b7280" }}>Make sure your integration has been added to at least one database.</span></div>}

        {!loading && !error && (
          <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: "6px" }}>
            {databases.length === 0 && (
              <div style={{ color: "#6b7280", fontSize: "0.68rem", textAlign: "center", padding: "20px", lineHeight: 1.8 }}>
                No databases found.<br />
                Make sure you've added your integration to a database via<br />
                <strong style={{ color: "#9ca3af" }}>⋯ Menu → Add connections</strong> in Notion.
              </div>
            )}
            {databases.map((db) => (
              <div key={db.id} onClick={() => setSelectedDb(db)}
                style={{ padding: "12px 14px", borderRadius: "10px", cursor: "pointer", background: selectedDb?.id === db.id ? "#001B44" : "#06090f", border: `1px solid ${selectedDb?.id === db.id ? "#4B9CD3" : "#1f2937"}`, display: "flex", alignItems: "center", gap: "10px", transition: "all 0.15s" }}>
                <span style={{ fontSize: "1.1rem" }}>🗄</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: selectedDb?.id === db.id ? "#7EC8E3" : "#d1d5db", fontSize: "0.75rem", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {getDbTitle(db)}
                  </div>
                  <div style={{ color: "#374151", fontSize: "0.56rem", marginTop: "2px", fontFamily: "monospace" }}>{db.id}</div>
                </div>
                {selectedDb?.id === db.id && <span style={{ color: "#4B9CD3", fontSize: "0.8rem" }}>✓</span>}
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: "20px", display: "flex", gap: "10px", justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ background: "transparent", border: "1px solid #374151", color: "#6b7280", borderRadius: "8px", padding: "9px 18px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.68rem", cursor: "pointer" }}>CANCEL</button>
          <button onClick={confirm} disabled={!selectedDb}
            style={{ background: !selectedDb ? "#1f2937" : "linear-gradient(135deg,#4B9CD3,#4B9CD3)", color: !selectedDb ? "#4b5563" : "#fff", border: "none", borderRadius: "8px", padding: "9px 20px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.68rem", cursor: !selectedDb ? "not-allowed" : "pointer" }}>
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
      // Try exact match first
      const exact = Object.keys(notionSchema).find((k) => k.toLowerCase() === lower);
      if (exact) { mapping[h] = exact; return; }
      // Try partial match
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
    <div style={{ position: "fixed", inset: 0, background: "#040810ee", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px" }}>
      <div style={{ background: "#0b0f1a", border: "1px solid #1f2937", borderRadius: "20px", padding: "28px", maxWidth: "640px", width: "100%", maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
          <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: "1rem", color: "#7EC8E3" }}>Map Columns → Notion</div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "#6b7280", cursor: "pointer", fontSize: "1.2rem" }}>✕</button>
        </div>
        <div style={{ color: "#6b7280", fontSize: "0.62rem", marginBottom: "18px" }}>
          Match each spreadsheet column to a Notion database property. Unmapped columns are skipped.
        </div>

        <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: "7px" }}>
          {spreadsheetHeaders.map((h) => {
            const currentVal = mapping[h] || "";
            const notionProp = notionSchema[currentVal];
            const meta = NOTION_PROP_META[notionProp?.type] || { color: "#6b7280", icon: "?" };
            return (
              <div key={h} style={{ display: "flex", alignItems: "center", gap: "10px", background: "#06090f", borderRadius: "10px", padding: "10px 12px", border: `1px solid ${currentVal ? "#4B9CD320" : "#1f2937"}` }}>
                {/* Spreadsheet column */}
                <div style={{ flex: "0 0 180px", minWidth: 0 }}>
                  <div style={{ color: "#f9fafb", fontSize: "0.72rem", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h}</div>
                  <div style={{ color: "#374151", fontSize: "0.53rem", marginTop: "1px" }}>spreadsheet col</div>
                </div>

                <div style={{ color: "#374151", fontSize: "0.8rem" }}>→</div>

                {/* Notion property selector */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <select
                    value={currentVal}
                    onChange={(e) => setMap(h, e.target.value)}
                    style={{ width: "100%", background: "#04060f", border: `1px solid ${currentVal ? "#4B9CD3" : "#374151"}`, borderRadius: "7px", padding: "6px 10px", color: currentVal ? "#7EC8E3" : "#6b7280", fontSize: "0.68rem", fontFamily: "monospace", outline: "none", cursor: "pointer" }}
                  >
                    <option value="">— skip this column —</option>
                    {editableProps.map(([name, prop]) => {
                      const m = NOTION_PROP_META[prop.type] || { icon: "?" };
                      return (
                        <option key={name} value={name}>
                          {m.icon} {name} ({prop.type})
                        </option>
                      );
                    })}
                  </select>
                </div>

                {/* Type badge */}
                {notionProp && (
                  <div style={{ flexShrink: 0, background: meta.color + "18", border: `1px solid ${meta.color}30`, borderRadius: "6px", padding: "3px 7px", fontSize: "0.56rem", color: meta.color, fontFamily: "'Syne',sans-serif", fontWeight: 700, whiteSpace: "nowrap" }}>
                    {meta.icon} {notionProp.type}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: "18px", paddingTop: "14px", borderTop: "1px solid #1f2937", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ color: "#6b7280", fontSize: "0.62rem" }}>{mappedCount} of {spreadsheetHeaders.length} columns mapped</span>
          <div style={{ display: "flex", gap: "10px" }}>
            <button onClick={onClose} style={{ background: "transparent", border: "1px solid #374151", color: "#6b7280", borderRadius: "8px", padding: "9px 18px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.68rem", cursor: "pointer" }}>CANCEL</button>
            <button onClick={() => onConfirm(mapping)} disabled={mappedCount === 0}
              style={{ background: mappedCount === 0 ? "#1f2937" : "linear-gradient(135deg,#4B9CD3,#4B9CD3)", color: mappedCount === 0 ? "#4b5563" : "#fff", border: "none", borderRadius: "8px", padding: "9px 20px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.68rem", cursor: mappedCount === 0 ? "not-allowed" : "pointer" }}>
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
    <div style={{ position: "fixed", inset: 0, background: "#040810ee", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px" }}>
      <div style={{ background: "#0b0f1a", border: "1px solid #1f2937", borderRadius: "18px", padding: "32px", maxWidth: "400px", width: "100%", textAlign: "center" }}>
        <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: "1rem", color: done ? "#34d399" : "#7EC8E3", marginBottom: "8px" }}>
          {done ? "✓ Upload Complete" : "Pushing to Notion…"}
        </div>
        <div style={{ color: "#6b7280", fontSize: "0.65rem", marginBottom: "20px" }}>
          {pushed + failed} of {total} rows processed
        </div>

        {/* Progress bar */}
        <div style={{ background: "#0d1220", borderRadius: "4px", height: "6px", marginBottom: "16px", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: failed > 0 ? "linear-gradient(90deg,#4B9CD3,#ef4444)" : "linear-gradient(90deg,#4B9CD3,#7EC8E3)", borderRadius: "4px", transition: "width 0.3s ease" }} />
        </div>

        <div style={{ display: "flex", justifyContent: "center", gap: "20px", marginBottom: "20px" }}>
          <div>
            <div style={{ color: "#34d399", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "1.2rem" }}>{pushed}</div>
            <div style={{ color: "#374151", fontSize: "0.52rem", letterSpacing: "2px" }}>PUSHED</div>
          </div>
          {failed > 0 && (
            <div>
              <div style={{ color: "#f87171", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "1.2rem" }}>{failed}</div>
              <div style={{ color: "#374151", fontSize: "0.52rem", letterSpacing: "2px" }}>FAILED</div>
            </div>
          )}
        </div>

        {done && (
          <button onClick={onClose} style={{ background: "linear-gradient(135deg,#4B9CD3,#4B9CD3)", color: "#fff", border: "none", borderRadius: "8px", padding: "9px 24px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.7rem", cursor: "pointer" }}>
            DONE
          </button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  // Files
  const [file1, setFile1] = useState(null);
  const [file2, setFile2] = useState(null);

  // Parsed / merged data
  const [mergedData, setMergedData] = useState(null);
  const [headers, setHeaders] = useState([]);
  const [colTypes, setColTypes] = useState({});
  const [parseInfo, setParseInfo] = useState([]);

  // Notion — database is hardcoded, no selection needed
  const [showDbPicker, setShowDbPicker]     = useState(false);
  const [targetDb, setTargetDb]             = useState({ id: "31a9b1412417803abaf5e164229a0d54", title: "Orders" });
  const [notionSchema, setNotionSchema]     = useState(null);
  const [showMapper, setShowMapper]         = useState(false);
  const [columnMapping, setColumnMapping]   = useState(null);

  // Push progress
  const [pushing, setPushing]         = useState(false);
  const [pushProgress, setPushProgress] = useState(null); // { total, pushed, failed }

  // UI
  const [sortCol, setSortCol]   = useState(null);
  const [sortDir, setSortDir]   = useState("asc");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [activeTab, setActiveTab] = useState("merged");

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

  // ── Parse & Merge ──
  const merge = useCallback(async () => {
    if (!file1 && !file2) { setError("Upload at least one file."); return; }
    setLoading(true); setError(null); setColumnMapping(null);
    try {
      let r1 = null, r2 = null;
      if (file1) r1 = await parseFile(file1);
      if (file2) r2 = await parseFile(file2);

      const allHeaderSet = new Set();
      if (r1) r1.headers.forEach((h) => allHeaderSet.add(h));
      if (r2) r2.headers.forEach((h) => allHeaderSet.add(h));
      const hdrs = [...allHeaderSet];

      const buildRows = (result, origin) => {
        if (!result || !result.dataRows.length) return [];
        return result.dataRows
          .filter((row) => row.some((c) => c !== ""))
          .map((row) => {
            const obj = { _source: result.name, _origin: origin };
            hdrs.forEach((h) => { const i = result.headers.indexOf(h); obj[h] = i !== -1 ? row[i] : ""; });
            return obj;
          });
      };

      const rows1 = buildRows(r1, "file1");
      const rows2 = buildRows(r2, "file2");
      const merged = [...rows1, ...rows2];

      const types = {};
      hdrs.forEach((h) => { types[h] = inferColType(h, merged.map((r) => String(r[h] ?? "").trim())); });

      const info = [];
      if (r1) info.push(`File 1: ${r1.dataRows.length} rows`);
      if (r2) info.push(`File 2: ${r2.dataRows.length} rows`);

      setHeaders(hdrs);
      setColTypes(types);
      setMergedData(merged);
      setParseInfo(info);
      setSortCol(null);
    } catch (e) {
      setError("Parse error: " + e.message);
    }
    setLoading(false);
  }, [file1, file2]);

  // ── Open column mapper ──
  const openMapper = useCallback(async () => {
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
    setShowMapper(true);
  }, [targetDb, notionSchema]);

  // ── Push rows to Notion ──
  const pushToNotion = useCallback(async (mapping) => {
    setShowMapper(false);
    setColumnMapping(mapping);
    if (!mergedData || !targetDb) return;

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

  const notionReady = !!targetDb;

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: "#040810", color: "#f9fafb", fontFamily: "'DM Mono','Courier New',monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@600;700;800&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: #0b0f1a; }
        ::-webkit-scrollbar-thumb { background: #1f2937; border-radius: 3px; }
        .th-sort:hover { background: #0d1220 !important; cursor: pointer; }
        .data-row:hover td { background: #080d18 !important; }
        .tab { background: none; border: none; cursor: pointer; padding: 10px 16px; font-family: 'Syne',sans-serif; font-size: 0.62rem; font-weight: 700; letter-spacing: 2px; color: #374151; border-bottom: 2px solid transparent; transition: all 0.2s; }
        .tab.on { color: #fb923c; border-bottom-color: #4B9CD3; }
        .tab:hover:not(.on) { color: #9ca3af; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spin { display: inline-block; animation: spin 1s linear infinite; }
        @keyframes slide-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .row-anim td { animation: slide-in 0.3s ease forwards; }
        select option { background: #0b0f1a; }
      `}</style>

      {/* Modals */}
      {showDbPicker && <DatabasePickerModal onSelect={handleDbSelected} onClose={() => setShowDbPicker(false)} />}
      {showMapper && notionSchema && mergedData && (
        <ColumnMapperModal
          spreadsheetHeaders={headers}
          notionSchema={notionSchema}
          onConfirm={pushToNotion}
          onClose={() => setShowMapper(false)}
        />
      )}
      {pushProgress && (
        <PushProgressModal
          {...pushProgress}
          done={!pushing}
          onClose={() => setPushProgress(null)}
        />
      )}

      {/* ── HEADER ── */}
      <div style={{ background: "linear-gradient(135deg,#04060f,#140a00)", borderBottom: "1px solid #001B44", padding: "14px 26px" }}>
        <div style={{ maxWidth: "1440px", margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div style={{ width: "30px", height: "30px", background: "linear-gradient(135deg,#4B9CD3,#7EC8E3)", borderRadius: "7px", display: "grid", placeItems: "center", fontSize: "0.9rem" }}>⬡</div>
            <div>
              <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: "1rem", letterSpacing: "-0.3px", background: "linear-gradient(90deg,#7EC8E3,#7EC8E3)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                R.A.M ENGINEERING
              </div>
              <div style={{ color: "#374151", fontSize: "0.49rem", letterSpacing: "3px" }}>ORDER FORM</div>
            </div>
          </div>

          {/* Notion database selector */}
          <div style={{ display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "5px", background: "#001B44", border: "1px solid #4B9CD340", borderRadius: "7px", padding: "5px 10px" }}>
              <div style={{ width: "5px", height: "5px", borderRadius: "50%", background: "#4B9CD3", boxShadow: "0 0 5px #4B9CD3" }} />
              <span style={{ color: "#7EC8E3", fontSize: "0.62rem" }}>Notion Connected</span>
            </div>
            <button onClick={() => setShowDbPicker(true)}
              style={{ background: "linear-gradient(135deg,#001B44,#001B44)", color: "#7EC8E3", border: "1px solid #4B9CD340", borderRadius: "7px", padding: "5px 11px", fontSize: "0.62rem", cursor: "pointer", fontFamily: "'Syne',sans-serif", fontWeight: 700 }}>
              🗄 {targetDb ? targetDb.title.length > 20 ? targetDb.title.slice(0, 20) + "…" : targetDb.title : "SELECT DATABASE"}
            </button>
            {targetDb && (
              <a href={`https://notion.so/${targetDb.id.replace(/-/g, "")}`} target="_blank" rel="noopener noreferrer"
                style={{ background: "transparent", border: "1px solid #4B9CD330", color: "#4B9CD3", borderRadius: "7px", padding: "5px 10px", fontSize: "0.6rem", textDecoration: "none", fontFamily: "'Syne',sans-serif", fontWeight: 700 }}>
                ↗ VIEW DB
              </a>
            )}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: "1440px", margin: "0 auto", padding: "18px 26px" }}>

        {/* ── NOTION STATUS PANEL ── */}
        <div style={{ background: notionReady ? "#001B44" : "#080d1a", border: `1px solid ${notionReady ? "#4B9CD330" : "#0d1220"}`, borderRadius: "14px", padding: "14px 18px", marginBottom: "14px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ fontSize: "1.2rem" }}>⬡</span>
              <div>
                <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.65rem", color: notionReady ? "#7EC8E3" : "#6b7280", letterSpacing: "1px" }}>
                  {notionReady ? "NOTION READY" : "NOTION SYNC"}
                </div>
                <div style={{ color: "#374151", fontSize: "0.58rem", marginTop: "1px" }}>
                  {!targetDb && (
                    <span>Connected · <button onClick={() => setShowDbPicker(true)} style={{ background: "none", border: "none", color: "#4B9CD3", cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", padding: 0, textDecoration: "underline" }}>Select a database ↗</button></span>
                  )}
                  {notionReady && (
                    <>Pushing to <strong style={{ color: "#7EC8E3" }}>"{targetDb.title}"</strong> · {columnMapping ? `${Object.values(columnMapping).filter(Boolean).length} columns mapped` : "Map columns before pushing"}</>
                  )}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: "7px", alignItems: "center" }}>
              {targetDb && (
                <button onClick={() => setShowDbPicker(true)}
                  style={{ background: "transparent", border: "1px solid #4B9CD340", color: "#4B9CD3", borderRadius: "7px", padding: "6px 12px", fontSize: "0.6rem", cursor: "pointer", fontFamily: "'Syne',sans-serif", fontWeight: 700 }}>
                  {targetDb ? "CHANGE DB" : "PICK DB"}
                </button>
              )}
              {notionReady && mergedData && (
                <button onClick={openMapper} disabled={pushing}
                  style={{ background: pushing ? "#1f2937" : "linear-gradient(135deg,#4B9CD3,#4B9CD3)", color: pushing ? "#4b5563" : "#fff", border: "none", borderRadius: "7px", padding: "6px 14px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.63rem", cursor: pushing ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: "5px" }}>
                  {pushing ? <><span className="spin">↻</span> PUSHING…</> : "↑ PUSH TO NOTION"}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ── UPLOAD ── */}
        <div style={{ background: "#080d1a", border: "1px solid #0d1220", borderRadius: "16px", padding: "16px", marginBottom: "14px" }}>
          <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.55rem", letterSpacing: "4px", color: "#374151", marginBottom: "10px" }}>UPLOAD FILES</div>
          <div style={{ display: "flex", gap: "10px", marginBottom: "10px", flexWrap: "wrap" }}>
            <DropZone label="First file (.xlsx / .xls / .csv)" sublabel="Excel or CSV export" icon="📗" accept=".csv,.xlsx,.xls" onFile={setFile1} file={file1} />
            <DropZone label="Second file to merge (optional)" sublabel="Rows appended below first file" icon="📊" accept=".xlsx,.xls,.csv" onFile={setFile2} file={file2} />
          </div>
          {error && <div style={{ color: "#f87171", fontSize: "0.67rem", padding: "6px 11px", background: "#160404", borderRadius: "7px", marginBottom: "8px" }}>⚠ {error}</div>}
          <div style={{ display: "flex", alignItems: "center", gap: "9px", flexWrap: "wrap" }}>
            <button onClick={merge} disabled={loading}
              style={{ background: loading ? "#111827" : "linear-gradient(135deg,#4B9CD3,#4B9CD3)", color: loading ? "#4b5563" : "#fff", border: "none", borderRadius: "9px", padding: "8px 20px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.7rem", letterSpacing: "1.5px", cursor: loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: "5px" }}>
              {loading ? <><span className="spin">↻</span> PARSING…</> : "⬡ MERGE FILES"}
            </button>
            {notionReady && mergedData && !columnMapping && <span style={{ color: "#4B9CD3", fontSize: "0.58rem" }}>↑ Push to Notion to map columns</span>}
            {columnMapping && <span style={{ color: "#34d399", fontSize: "0.58rem" }}>✓ Mapping saved — push again to re-upload</span>}
          </div>
        </div>

        {/* ── RESULTS ── */}
        {mergedData && (
          <>
            {/* Parse info */}
            {parseInfo.length > 0 && (
              <div style={{ background: "#08100d", border: "1px solid #34d39918", borderRadius: "8px", padding: "7px 13px", marginBottom: "10px", display: "flex", gap: "14px", flexWrap: "wrap" }}>
                <span style={{ color: "#374151", fontSize: "0.53rem", letterSpacing: "2px", fontFamily: "'Syne',sans-serif", fontWeight: 700, alignSelf: "center" }}>PARSED</span>
                {parseInfo.map((info, i) => <span key={i} style={{ color: "#34d399", fontSize: "0.61rem", fontFamily: "monospace" }}>{info}</span>)}
              </div>
            )}

            {/* Stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(132px,1fr))", gap: "8px", marginBottom: "11px" }}>
              {[
                { l: "TOTAL ROWS",  v: mergedData.length, c: "#4B9CD3" },
                { l: "COLUMNS",     v: headers.length,    c: "#7EC8E3" },
                totalQty !== null && { l: "TOTAL QTY",   v: totalQty.toLocaleString(), c: "#a5b4fc" },
                totalRevenue !== null && { l: "TOTAL VALUE", v: `$${totalRevenue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, c: "#6ee7b7" },
              ].filter(Boolean).map((s) => (
                <div key={s.l} style={{ background: "#080d1a", border: "1px solid #0d1220", borderRadius: "10px", padding: "11px" }}>
                  <div style={{ color: s.c, fontSize: "1.05rem", fontWeight: 700, fontFamily: "'Syne',sans-serif" }}>{s.v}</div>
                  <div style={{ color: "#1f2937", fontSize: "0.5rem", letterSpacing: "2px", marginTop: "2px" }}>{s.l}</div>
                </div>
              ))}
            </div>

            {/* Column mapping display */}
            <div style={{ background: "#080d1a", border: "1px solid #0d1220", borderRadius: "11px", padding: "10px 14px", marginBottom: "10px" }}>
              <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.53rem", letterSpacing: "4px", color: "#374151", marginBottom: "7px" }}>
                COLUMN TYPES {columnMapping && <span style={{ color: "#4B9CD3", marginLeft: "10px" }}>→ NOTION MAPPING ACTIVE</span>}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
                {headers.map((h) => {
                  const meta = COL_TYPE_META[colTypes[h]] || COL_TYPE_META.unknown;
                  const notionProp = columnMapping?.[h];
                  const notionPropType = notionProp && notionSchema?.[notionProp]?.type;
                  const nMeta = notionPropType ? NOTION_PROP_META[notionPropType] : null;
                  return (
                    <div key={h} style={{ display: "flex", alignItems: "center", gap: "4px", background: meta.badge, border: `1px solid ${meta.color}28`, borderRadius: "6px", padding: "3px 7px" }}>
                      <span style={{ color: meta.color, fontSize: "0.55rem", fontWeight: 700 }}>{meta.icon}</span>
                      <span style={{ color: "#d1d5db", fontSize: "0.63rem" }}>{h}</span>
                      {nMeta && (
                        <>
                          <span style={{ color: "#374151", fontSize: "0.5rem" }}>→</span>
                          <span style={{ color: nMeta.color, fontSize: "0.55rem" }}>{nMeta.icon} {notionProp}</span>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Tabs */}
            <div style={{ borderBottom: "1px solid #0d1220", marginBottom: "11px" }}>
              <button className={`tab ${activeTab === "merged" ? "on" : ""}`} onClick={() => setActiveTab("merged")}>MERGED TABLE</button>
              <button className={`tab ${activeTab === "notion" ? "on" : ""}`} onClick={() => setActiveTab("notion")}>NOTION MAPPING</button>
            </div>

            {/* Table */}
            {activeTab === "merged" && (
              <>
                <div style={{ overflowX: "auto", borderRadius: "11px", border: "1px solid #0d1220" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.71rem" }}>
                    <thead>
                      <tr style={{ background: "#06090f" }}>
                        {headers.map((h) => {
                          const meta = COL_TYPE_META[colTypes[h]] || COL_TYPE_META.unknown;
                          return (
                            <th key={h} className="th-sort" onClick={() => handleSort(h)}
                              style={{ padding: "9px 11px", textAlign: "left", borderBottom: "1px solid #0d1220", whiteSpace: "nowrap", background: sortCol === h ? "#0d1220" : undefined, userSelect: "none" }}>
                              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                <span style={{ color: meta.color, fontSize: "0.48rem", letterSpacing: "1px", fontFamily: "'Syne',sans-serif", fontWeight: 700 }}>{meta.icon} {meta.label}</span>
                                <span style={{ color: "#d1d5db", fontSize: "0.63rem", fontWeight: 500 }}>{h}{sortCol === h ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</span>
                              </div>
                            </th>
                          );
                        })}
                        <th style={{ padding: "9px 11px", borderBottom: "1px solid #0d1220", color: "#1f2937", fontFamily: "'Syne',sans-serif", fontSize: "0.5rem", letterSpacing: "2px" }}>SOURCE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayRows.slice(0, 500).map((row, i) => (
                        <tr key={i} className="data-row row-anim">
                          {headers.map((h) => (
                            <td key={h} style={{ padding: "7px 11px", borderBottom: "1px solid #06090f", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis" }}>
                              <Cell value={row[h]} type={colTypes[h]} />
                            </td>
                          ))}
                          <td style={{ padding: "7px 11px", borderBottom: "1px solid #06090f", color: "#374151", fontSize: "0.57rem", whiteSpace: "nowrap" }}>{row._source}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {displayRows.length > 500 && <div style={{ textAlign: "center", color: "#374151", fontSize: "0.61rem", marginTop: "6px" }}>Showing 500 of {displayRows.length} rows</div>}

                <div style={{ marginTop: "11px", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <span style={{ color: "#1f2937", fontSize: "0.56rem" }}>{mergedData.length} rows</span>
                  {notionReady && (
                    <button onClick={openMapper} disabled={pushing}
                      style={{ background: pushing ? "#1f2937" : "linear-gradient(135deg,#4B9CD3,#4B9CD3)", color: pushing ? "#4b5563" : "#fff", border: "none", borderRadius: "8px", padding: "7px 14px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.65rem", cursor: pushing ? "not-allowed" : "pointer" }}>
                      ↑ PUSH TO NOTION
                    </button>
                  )}
                  {!notionReady && (
                    <button onClick={() => setShowDbPicker(true)}
                      style={{ background: "transparent", border: "1px solid #4B9CD340", color: "#4B9CD3", borderRadius: "8px", padding: "7px 14px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.65rem", cursor: "pointer" }}>
                      ⬡ SELECT DATABASE TO PUSH
                    </button>
                  )}
                </div>
              </>
            )}

            {/* Notion mapping tab */}
            {activeTab === "notion" && (
              <div>
                {!targetDb && (
                  <div style={{ textAlign: "center", padding: "40px", color: "#374151" }}>
                    <div style={{ fontFamily: "'Syne',sans-serif", fontSize: "0.6rem", letterSpacing: "3px", marginBottom: "14px" }}>SELECT A DATABASE</div>
                    <button onClick={() => setShowDbPicker(true)} style={{ background: "linear-gradient(135deg,#4B9CD3,#4B9CD3)", color: "#fff", border: "none", borderRadius: "8px", padding: "9px 20px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.68rem", cursor: "pointer" }}>
                      PICK DATABASE
                    </button>
                  </div>
                )}
                {notionReady && !columnMapping && (
                  <div style={{ textAlign: "center", padding: "40px", color: "#374151" }}>
                    <div style={{ fontFamily: "'Syne',sans-serif", fontSize: "0.6rem", letterSpacing: "3px", marginBottom: "14px" }}>NO MAPPING YET</div>
                    <button onClick={openMapper} style={{ background: "linear-gradient(135deg,#4B9CD3,#4B9CD3)", color: "#fff", border: "none", borderRadius: "8px", padding: "9px 20px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.68rem", cursor: "pointer" }}>
                      MAP COLUMNS NOW
                    </button>
                  </div>
                )}
                {notionReady && columnMapping && notionSchema && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
                    <div style={{ color: "#374151", fontSize: "0.58rem", marginBottom: "4px" }}>Current column → Notion property mapping:</div>
                    {headers.map((h) => {
                      const notionProp = columnMapping[h];
                      const propType = notionProp && notionSchema[notionProp]?.type;
                      const meta = propType ? NOTION_PROP_META[propType] : null;
                      return (
                        <div key={h} style={{ display: "flex", alignItems: "center", gap: "10px", background: notionProp ? "#001B44" : "#06090f", border: `1px solid ${notionProp ? "#4B9CD330" : "#1f2937"}`, borderRadius: "9px", padding: "9px 12px" }}>
                          <span style={{ color: "#d1d5db", fontSize: "0.72rem", fontFamily: "monospace", flex: "0 0 180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h}</span>
                          <span style={{ color: "#374151" }}>→</span>
                          {notionProp ? (
                            <span style={{ color: meta?.color || "#4B9CD3", fontSize: "0.68rem", fontFamily: "monospace" }}>{meta?.icon} {notionProp} <span style={{ color: "#374151" }}>({propType})</span></span>
                          ) : (
                            <span style={{ color: "#374151", fontSize: "0.65rem" }}>skipped</span>
                          )}
                        </div>
                      );
                    })}
                    <div style={{ marginTop: "10px", display: "flex", gap: "8px" }}>
                      <button onClick={openMapper} style={{ background: "transparent", border: "1px solid #4B9CD340", color: "#4B9CD3", borderRadius: "8px", padding: "7px 14px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.63rem", cursor: "pointer" }}>
                        ✎ EDIT MAPPING
                      </button>
                      <button onClick={() => pushToNotion(columnMapping)} disabled={pushing}
                        style={{ background: "linear-gradient(135deg,#4B9CD3,#4B9CD3)", color: "#fff", border: "none", borderRadius: "8px", padding: "7px 14px", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: "0.63rem", cursor: "pointer" }}>
                        ↑ RE-PUSH ALL ROWS
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Empty state */}
        {!mergedData && (
          <div style={{ textAlign: "center", padding: "48px 20px", color: "#1f2937" }}>
            <div style={{ fontSize: "1.9rem", marginBottom: "10px", opacity: 0.35 }}>⬡</div>
            <div style={{ fontFamily: "'Syne',sans-serif", fontSize: "0.58rem", letterSpacing: "4px", marginBottom: "14px" }}>THE LOOP</div>
            <div style={{ color: "#1f2937", fontSize: "0.64rem", lineHeight: 2.3, maxWidth: "460px", margin: "0 auto", textAlign: "left" }}>
              <div>① <span style={{ color: "#4B9CD3" }}>Select database</span> → pick which Notion DB to push to</div>
              <div>② <span style={{ color: "#34d399" }}>Upload files</span> → Excel or CSV, one or two files</div>
              <div>③ <span style={{ color: "#818cf8" }}>Map columns</span> → match spreadsheet cols to Notion properties</div>
              <div>④ <span style={{ color: "#f472b6" }}>Push</span> → rows become pages in your Notion database</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
