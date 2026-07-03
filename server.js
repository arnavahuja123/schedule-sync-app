const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DB_PATH = path.join(ROOT, "data", "db.json");
const FLAT_DB_PATH = path.join(ROOT, "db.json");
const ACTIVE_DB_PATH = process.env.DATA_FILE || "";

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
  const dbPath = await getDbPath();
  const raw = await fs.readFile(dbPath, "utf8");
  return ensureDbShape(JSON.parse(raw));
}

async function saveDb(db) {
  const dbPath = await getDbPath();
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2));
}

async function existingPath(primary, fallback) {
  try {
    await fs.access(primary);
    return primary;
  } catch {
    return fallback;
  }
}

async function getDbPath() {
  if (!ACTIVE_DB_PATH) return existingPath(DB_PATH, FLAT_DB_PATH);

  try {
    await fs.access(ACTIVE_DB_PATH);
  } catch {
    const seedPath = await existingPath(DB_PATH, FLAT_DB_PATH);
    const seed = await fs.readFile(seedPath, "utf8");
    await fs.mkdir(path.dirname(ACTIVE_DB_PATH), { recursive: true });
    await fs.writeFile(ACTIVE_DB_PATH, seed);
  }

  return ACTIVE_DB_PATH;
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || `person-${Date.now()}`;
}

function ensureDbShape(db) {
  db.groups = Array.isArray(db.groups) && db.groups.length
    ? db.groups
    : [{ id: "engineering-2026", name: "Engineering 2026", code: "ENG2026" }];
  db.people = Array.isArray(db.people) ? db.people : [];
  db.notifications = Array.isArray(db.notifications) ? db.notifications : [];

  const fallbackGroupId = db.groups[0].id;
  db.people = db.people.map((person) => ({
    ...person,
    groupId: person.groupId || fallbackGroupId
  }));

  return db;
}

function makeInviteCode(name, existingCodes) {
  const prefix = String(name || "GROUP").replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 4) || "GRP";
  let code = "";
  do {
    code = `${prefix}${Math.floor(1000 + Math.random() * 9000)}`;
  } while (existingCodes.has(code));
  return code;
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
    start: normalizeTime(item.start || item.startTime || ""),
    end: normalizeTime(item.end || item.endTime || ""),
    term: normalizeTerm(item.term)
  };
}

function normalizeTerm(value) {
  return String(value || "fall").trim().toLowerCase() === "winter" ? "winter" : "fall";
}

function normalizeTime(value) {
  const raw = String(value || "").trim().toUpperCase().replace(/\s+/g, "");
  const match = raw.match(/^(\d{1,2})(?::?(\d{2}))?(AM|PM)?$/);
  if (!match) return raw;

  let hour = Number(match[1]);
  const minute = match[2] || "00";
  const meridian = match[3];

  if (meridian === "PM" && hour < 12) hour += 12;
  if (meridian === "AM" && hour === 12) hour = 0;

  return `${String(hour).padStart(2, "0")}:${minute}`;
}

function dayKey(value) {
  const normalized = String(value || "").trim().toLowerCase().slice(0, 3);
  const dayMap = {
    mon: "mon",
    tue: "tue",
    wed: "wed",
    thu: "thu",
    fri: "fri",
    sat: "sat",
    sun: "sun"
  };

  return dayMap[normalized] || "";
}

function normalizedDays(days) {
  return (Array.isArray(days) ? days : String(days || "").split(/[,\s/]+/))
    .map(dayKey)
    .filter(Boolean);
}

function compactText(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

function courseIdentity(item) {
  const text = compactText(`${item.course} ${item.title}`);
  const courseMatch = text.match(/\b([A-Z]{2,8})\s*([0-9][A-Z0-9]{2,4})\b/);
  const sectionMatch = text.match(/\b([CLT][0-9]{2,3})\b/);
  const typeMatch = text.match(/\b(LECTURE|TUTORIAL|LABORATORY|LAB)\b/);

  return {
    courseCode: courseMatch ? `${courseMatch[1]} ${courseMatch[2]}` : compactText(item.course),
    section: sectionMatch ? sectionMatch[1] : "",
    type: typeMatch ? typeMatch[1].replace("LABORATORY", "LAB") : "",
    time: item.start && item.end ? `${item.start}-${item.end}` : "",
    room: compactText(item.room),
    days: normalizedDays(item.days),
    term: normalizeTerm(item.term)
  };
}

function matchingKeys(item) {
  const identity = courseIdentity(item);
  if (!identity.courseCode) return [];

  const keys = new Set();
  for (const day of identity.days) {
    if (identity.section && identity.time) keys.add(`${identity.term}|${identity.courseCode}|${day}|${identity.section}|${identity.time}`);
    if (identity.section && identity.type) keys.add(`${identity.term}|${identity.courseCode}|${day}|${identity.section}|${identity.type}`);
    if (identity.time && identity.type) keys.add(`${identity.term}|${identity.courseCode}|${day}|${identity.type}|${identity.time}`);
    if (identity.room && identity.time) keys.add(`${identity.term}|${identity.courseCode}|${day}|${identity.room}|${identity.time}`);
  }

  return [...keys];
}

function buildMatches(people, groupId = "") {
  const scopedPeople = groupId ? people.filter((person) => person.groupId === groupId) : people;
  const buckets = new Map();

  for (const person of scopedPeople) {
    for (const klass of person.classes || []) {
      if (!klass.course) continue;
      for (const key of matchingKeys(klass)) {
        if (!buckets.has(key)) buckets.set(key, { classInfo: klass, peopleById: new Map() });
        buckets.get(key).peopleById.set(person.id, { id: person.id, name: person.name, color: person.color });
      }
    }
  }

  const seenGroups = new Set();
  return [...buckets.values()]
    .map((entry) => ({ classInfo: entry.classInfo, people: [...entry.peopleById.values()] }))
    .filter((entry) => entry.people.length > 1)
    .filter((entry) => {
      const identity = courseIdentity(entry.classInfo);
      const groupKey = `${identity.term}|${identity.courseCode}|${identity.days.join(",")}|${identity.section}|${identity.type}|${identity.time}|${entry.people.map((person) => person.id).sort().join(",")}`;
      if (seenGroups.has(groupKey)) return false;
      seenGroups.add(groupKey);
      return true;
    })
    .sort((a, b) => a.classInfo.course.localeCompare(b.classInfo.course));
}

function createNotifications(db, person, term = "") {
  const activeTerm = normalizeTerm(term);
  const matches = buildMatches(db.people, person.groupId)
    .filter((match) => normalizeTerm(match.classInfo.term) === activeTerm);
  const timestamp = new Date().toISOString();
  const fresh = [];

  for (const match of matches) {
    if (!match.people.some((member) => member.id === person.id)) continue;
    const friends = match.people.filter((member) => member.id !== person.id).map((member) => member.name);
    fresh.push({
      id: `${timestamp}-${person.id}-${match.classInfo.term || "fall"}-${match.classInfo.course}-${fresh.length}`,
      personId: person.id,
      createdAt: timestamp,
      message: `${person.name}, you have ${match.classInfo.course} with ${friends.join(", ")} in ${normalizeTerm(match.classInfo.term)}.`,
      classInfo: match.classInfo,
      friendNames: friends
    });
  }

  db.notifications = [...fresh, ...(db.notifications || [])].slice(0, 80);
}

function groupNotifications(db, groupId) {
  const groupPeopleIds = new Set(db.people.filter((person) => person.groupId === groupId).map((person) => person.id));
  return (db.notifications || []).filter((note) => groupPeopleIds.has(note.personId));
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);
  const prompt = [
    "Read this student schedule image and return only valid JSON.",
    "Use this schema: {\"classes\":[{\"course\":\"string\",\"title\":\"string\",\"teacher\":\"string\",\"room\":\"string\",\"days\":[\"Mon\"],\"start\":\"HH:MM\",\"end\":\"HH:MM\"}]}",
    "For course, include the subject, course number, and section when visible, for example \"MATH 1ZC3 C02\" or \"MATH 1ZA3 T02\".",
    "For title, include the meeting type such as Lecture, Tutorial, or Laboratory.",
    "If a value is missing, use an empty string or empty array. Do not include markdown."
  ].join(" ");

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
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
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Gemini took too long to scan. Try a smaller or clearer image.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini scan failed: ${response.status} ${detail.slice(0, 240)}`);
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
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    const requestedGroupId = url.searchParams.get("groupId");
    const activeGroup = requestedGroupId ? db.groups.find((group) => group.id === requestedGroupId) : null;
    if (!activeGroup) {
      return sendJson(res, 200, {
        activeGroup: null,
        people: [],
        matches: [],
        notifications: []
      });
    }

    const people = db.people.filter((person) => person.groupId === activeGroup.id);
    return sendJson(res, 200, {
      activeGroup,
      people,
      matches: buildMatches(db.people, activeGroup.id),
      notifications: (db.notifications || []).filter((note) => people.some((person) => person.id === note.personId))
    });
  }

  if (req.method === "POST" && pathname === "/api/groups") {
    const body = await readJsonBody(req);
    const db = await loadDb();
    const name = String(body.name || "New Group").trim();
    const group = {
      id: slugify(name),
      name,
      code: makeInviteCode(name, new Set(db.groups.map((item) => item.code)))
    };

    while (db.groups.some((item) => item.id === group.id)) {
      group.id = `${group.id}-${Math.floor(Math.random() * 999)}`;
    }

    db.groups.push(group);
    await saveDb(db);
    return sendJson(res, 201, { group });
  }

  if (req.method === "POST" && pathname === "/api/groups/join") {
    const body = await readJsonBody(req);
    const db = await loadDb();
    const code = String(body.code || "").trim().toUpperCase();
    const group = db.groups.find((item) => item.code.toUpperCase() === code);
    if (!group) return sendJson(res, 404, { error: "Group code not found." });
    return sendJson(res, 200, { group });
  }

  if (req.method === "POST" && pathname === "/api/people") {
    const body = await readJsonBody(req);
    const db = await loadDb();
    const group = db.groups.find((item) => item.id === body.groupId);
    if (!group) return sendJson(res, 400, { error: "Join or create a private group first." });
    const person = {
      id: slugify(body.name),
      name: String(body.name || "New Person").trim(),
      color: body.color || "#7b61ff",
      groupId: group.id,
      classes: []
    };

    while (db.people.some((item) => item.id === person.id)) {
      person.id = `${person.id}-${Math.floor(Math.random() * 999)}`;
    }

    db.people.push(person);
    await saveDb(db);
    return sendJson(res, 201, { person, matches: buildMatches(db.people, group.id) });
  }

  if (req.method === "PUT" && pathname.startsWith("/api/people/")) {
    const personId = decodeURIComponent(pathname.split("/").pop());
    const body = await readJsonBody(req);
    const db = await loadDb();
    const person = db.people.find((item) => item.id === personId);
    if (!person) return sendJson(res, 404, { error: "Person not found." });

    person.name = String(body.name || person.name).trim();
    person.color = body.color || person.color;
    await saveDb(db);
    return sendJson(res, 200, {
      person,
      people: db.people.filter((item) => item.groupId === person.groupId),
      matches: buildMatches(db.people, person.groupId),
      notifications: groupNotifications(db, person.groupId)
    });
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/people/")) {
    const personId = decodeURIComponent(pathname.split("/").pop());
    const db = await loadDb();
    const beforeCount = db.people.length;
    db.people = db.people.filter((item) => item.id !== personId);
    if (db.people.length === beforeCount) return sendJson(res, 404, { error: "Person not found." });
    db.notifications = (db.notifications || []).filter((note) => note.personId !== personId);

    await saveDb(db);
    const activeGroupId = db.groups[0]?.id || "";
    return sendJson(res, 200, {
      people: db.people.filter((item) => item.groupId === activeGroupId),
      matches: buildMatches(db.people, activeGroupId),
      notifications: db.notifications || []
    });
  }

  if (req.method === "POST" && pathname === "/api/schedules") {
    const body = await readJsonBody(req);
    const db = await loadDb();
    const person = db.people.find((item) => item.id === body.personId);
    if (!person) return sendJson(res, 404, { error: "Person not found." });

    const term = normalizeTerm(body.term);
    const nextClasses = (body.classes || [])
      .map((item) => normalizeClass({ ...item, term }))
      .filter((item) => item.course);
    person.classes = [
      ...(person.classes || []).map(normalizeClass).filter((item) => normalizeTerm(item.term) !== term),
      ...nextClasses
    ];
    createNotifications(db, person, term);
    await saveDb(db);
    return sendJson(res, 200, {
      person,
      matches: buildMatches(db.people, person.groupId),
      notifications: groupNotifications(db, person.groupId)
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
