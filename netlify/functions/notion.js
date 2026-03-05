// netlify/functions/notion.js
exports.handler = async (event) => {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  try {
    // Token is stored securely in Netlify environment variables
    const token = process.env.NOTION_TOKEN;
    if (!token) {
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: "Notion token not configured on server" }),
      };
    }

    const { path: notionPath, method, body } = JSON.parse(event.body || "{}");

    if (!notionPath) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: "Missing path" }),
      };
    }

    const url = `https://api.notion.com/v1${notionPath}`;

    const res = await fetch(url, {
      method: method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await res.json();

    return {
      statusCode: res.status,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
