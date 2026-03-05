// netlify/functions/notion.js
// This is the proxy that sits between your browser and the Notion API.
// Netlify runs this as a serverless function — no separate server needed.

exports.handler = async (event) => {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  // Handle preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  try {
    const { path: notionPath, method, body, token } = JSON.parse(event.body || "{}");

    if (!notionPath || !token) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: "Missing path or token" }),
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
