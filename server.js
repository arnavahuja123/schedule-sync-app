const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DB_PATH = path.join(ROOT, "data", "db.json");
const FLAT_DB_PATH = path.join(ROOT, "db.json");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

async function readJsonBody(req, limitBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const error = new Error("Payload is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function loadDb() {
  const raw = await fs.readFile(await existingPath(DB_PATH, FLAT_DB_PATH), "utf8");
  return JSON.parse(raw);
}

async function saveDb(db) {
  await fs.writeFile(await existingPath(DB_PATH, FLAT_DB_PATH), JSON.stringify(db, null, 2));
}

async function existingPath(primary, fallback) {
  try {
    await fs.access(primary);
    return primary;
  } catch {
    return fallback;
  }
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || `person-${Date.now()}`;
}

function normalizeClass(item) {
  const days = Array.isArray(item.days)
    ? item.days
    : String(item.days || "")
        .split(/[,\s/]+/)
        .map((day) => day.trim())
        .filter(Boolean);

  return {
    course: String(item.course || item.code || "").trim().toUpperCase(),
    title: String(item.title || item.name || "").trim(),
    teacher: String(item.teacher || "").trim(),
    room: String(item.room || "").trim(),
    days,
    start: String(item.start || item.startTime || "").trim(),
    end: String(item.end || item.endTime || "").trim()
  };
}

function classKey(item) {
  const days = [...(item.days || [])].sort().join(",");
  return [
    item.course.trim().toUpperCase(),
    item.teacher.trim().toLowerCase(),
    item.room.trim().toLowerCase(),
    days,
    item.start,
    item.end
  ].join("|");
}

function looseClassKey(item) {
  return [
    item.course.trim().toUpperCase(),
    item.teacher.trim().toLowerCase(),
    item.room.trim().toLowerCase()
  ].join("|");
}

function buildMatches(people) {
  const buckets = new Map();

  for (const person of people) {
    for (const klass of person.classes || []) {
      if (!klass.course) continue;
      const exact = classKey(klass);
      const loose = looseClassKey(klass);
      const key = exact.replace(/\|+$/, "") === loose ? loose : exact;
      if (!buckets.has(key)) buckets.set(key, { classInfo: klass, people: [] });
      buckets.get(key).people.push({ id: person.id, name: person.name, color: person.color });
    }
  }

  return [...buckets.values()]
    .filter((entry) => entry.people.length > 1)
    .sort((a, b) => a.classInfo.course.localeCompare(b.classInfo.course));
}

function createNotifications(db, person) {
  const matches = buildMatches(db.people);
  const timestamp = new Date().toISOString();
  const fresh = [];

  for (const match of matches) {
    if (!match.people.some((member) => member.id === person.id)) continue;
    const friends = match.people.filter((member) => member.id !== person.id).map((member) => member.name);
    fresh.push({
      id: `${timestamp}-${person.id}-${match.classInfo.course}-${fresh.length}`,
      personId: person.id,
      createdAt: timestamp,
      message: `${person.name}, you have ${match.classInfo.course} with ${friends.join(", ")}.`,
      classInfo: match.classInfo,
      friendNames: friends
    });
  }

  db.notifications = [...fresh, ...(db.notifications || [])].slice(0, 80);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function scanScheduleWithGemini({ imageBase64, mimeType }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      demo: true,
      classes: [
        {
          course: "ENG3U",
          title: "English",
          teacher: "Ms. Wong",
          room: "214",
          days: ["Mon", "Wed", "Fri"],
          start: "09:00",
          end: "10:15"
        },
        {
          course: "ICS3U",
          title: "Computer Science",
          teacher: "Mr. Green",
          room: "201",
          days: ["Tue", "Thu"],
          start: "14:00",
          end: "15:15"
        }
      ],
      note: "Set GEMINI_API_KEY before starting the server to scan the actual image."
    };
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const prompt = [
    "Read this student schedule image and return only valid JSON.",
    "Use this schema: {\"classes\":[{\"course\":\"string\",\"title\":\"string\",\"teacher\":\"string\",\"room\":\"string\",\"days\":[\"Mon\"],\"start\":\"HH:MM\",\"end\":\"HH:MM\"}]}",
    "If a value is missing, use an empty string or empty array. Do not include markdown."
  ].join(" ");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: mimeType || "image/png",
                data: imageBase64
              }
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json"
      }
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini scan failed: ${response.status} ${detail}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
  if (!text) throw new Error("Gemini did not return schedule text.");
  const parsed = JSON.parse(text);

  return {
    demo: false,
    classes: (parsed.classes || []).map(normalizeClass)
  };
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/state") {
    const db = await loadDb();
    return sendJson(res, 200, {
      people: db.people,
      matches: buildMatches(db.people),
      notifications: db.notifications || []
    });
  }

  if (req.method === "POST" && pathname === "/api/people") {
    const body = await readJsonBody(req);
    const db = await loadDb();
    const person = {
      id: slugify(body.name),
      name: String(body.name || "New Friend").trim(),
      color: body.color || "#7b61ff",
      classes: []
    };

    while (db.people.some((item) => item.id === person.id)) {
      person.id = `${person.id}-${Math.floor(Math.random() * 999)}`;
    }

    db.people.push(person);
    await saveDb(db);
    return sendJson(res, 201, { person, matches: buildMatches(db.people) });
  }

  if (req.method === "POST" && pathname === "/api/schedules") {
    const body = await readJsonBody(req);
    const db = await loadDb();
    const person = db.people.find((item) => item.id === body.personId);
    if (!person) return sendJson(res, 404, { error: "Person not found." });

    person.classes = (body.classes || []).map(normalizeClass).filter((item) => item.course);
    createNotifications(db, person);
    await saveDb(db);
    return sendJson(res, 200, {
      person,
      matches: buildMatches(db.people),
      notifications: db.notifications || []
    });
  }

  if (req.method === "POST" && pathname === "/api/scan") {
    const body = await readJsonBody(req);
    if (!body.imageBase64) return sendJson(res, 400, { error: "Missing imageBase64." });
    const result = await scanScheduleWithGemini(body);
    return sendJson(res, 200, result);
  }

  return sendJson(res, 404, { error: "Not found." });
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const publicPath = path.normalize(path.join(PUBLIC_DIR, safePath));
  const flatPath = path.normalize(path.join(ROOT, safePath));
  const filePath = await existingPath(publicPath, flatPath);

  if (!filePath.startsWith(PUBLIC_DIR) && !filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "content-type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
    } else {
      await serveStatic(req, res, url.pathname);
    }
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "Server error." });
  }
});

server.listen(PORT, () => {
  console.log(`Schedule Sync is running at http://localhost:${PORT}`);
});
