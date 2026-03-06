// api/notion.js
// Vercel serverless function — proxies requests to Notion API
export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    const token = process.env.NOTION_TOKEN;
    if (!token) {
      return res.status(500).json({ error: "Notion token not configured on server" });
    }

    const { path: notionPath, method, body } = req.body;

    if (!notionPath) {
      return res.status(400).json({ error: "Missing path" });
    }

    const url = `https://api.notion.com/v1${notionPath}`;

    const response = await fetch(url, {
      method: method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json();
    return res.status(response.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
