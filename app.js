let state = {
  people: [],
  matches: [],
  notifications: []
};

let selectedId = null;
let selectedColor = "#2f80ed";
let draftClasses = [];
let selectedImage = null;

const $ = (selector) => document.querySelector(selector);
const friendList = $("#friendList");
const selectedName = $("#selectedName");
const classTable = $("#classTable");
const matchList = $("#matchList");
const notificationList = $("#notificationList");
const scanStatus = $("#scanStatus");

function selectedPerson() {
  return state.people.find((person) => person.id === selectedId) || state.people[0];
}

function setStatus(message) {
  scanStatus.textContent = message;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed.");
  return payload;
}

function parseDays(value) {
  return String(value || "")
    .split(/[,\s/]+/)
    .map((day) => day.trim())
    .filter(Boolean);
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;

  for (const char of line) {
    if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current.trim());
  return cells;
}

function csvToClasses(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase());

  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const item = Object.fromEntries(headers.map((header, index) => [header, cells[index] || ""]));
    return {
      course: item.course,
      title: item.title,
      teacher: item.teacher,
      room: item.room,
      days: parseDays(item.days),
      start: item.start,
      end: item.end
    };
  }).filter((item) => item.course);
}

function renderFriends() {
  friendList.innerHTML = state.people.map((person) => `
    <button class="friend-item ${person.id === selectedId ? "active" : ""}" data-person-id="${person.id}" type="button">
      <span class="avatar" style="background:${person.color}"></span>
      <span>
        <strong>${person.name}</strong>
        <span class="subtext">${person.classes.length} classes</span>
      </span>
    </button>
  `).join("");

  friendList.querySelectorAll(".friend-item").forEach((button) => {
    button.addEventListener("click", () => {
      selectedId = button.dataset.personId;
      draftClasses = [...(selectedPerson()?.classes || [])];
      render();
    });
  });
}

function renderClasses() {
  if (!draftClasses.length) {
    classTable.innerHTML = `<div class="empty-state">No classes added yet.</div>`;
    return;
  }

  classTable.innerHTML = draftClasses.map((klass, index) => `
    <div class="class-row">
      <div>
        <div class="course-code">${klass.course}</div>
        <div class="subtext">${klass.days.join(" ")}</div>
      </div>
      <div>
        <strong>${klass.title || "Untitled class"}</strong>
        <div class="subtext">${klass.start || "--:--"} - ${klass.end || "--:--"}</div>
      </div>
      <div class="subtext">${klass.teacher || "No teacher"}</div>
      <div class="subtext">${klass.room || "No room"}</div>
      <button class="icon-btn" data-remove-index="${index}" title="Remove class" type="button">×</button>
    </div>
  `).join("");

  classTable.querySelectorAll("[data-remove-index]").forEach((button) => {
    button.addEventListener("click", () => {
      draftClasses.splice(Number(button.dataset.removeIndex), 1);
      renderClasses();
    });
  });
}

function renderMatches() {
  if (!state.matches.length) {
    matchList.innerHTML = `<div class="empty-state">Shared classes appear here after schedules are saved.</div>`;
    return;
  }

  matchList.innerHTML = state.matches.map((match) => `
    <article class="match-card">
      <h4>${match.classInfo.course} ${match.classInfo.title ? `· ${match.classInfo.title}` : ""}</h4>
      <p class="subtext">${match.classInfo.teacher || "Teacher TBD"} · ${match.classInfo.room || "Room TBD"} · ${(match.classInfo.days || []).join(" ")}</p>
      <div class="people-chips">
        ${match.people.map((person) => `
          <span class="chip"><span class="chip-dot" style="background:${person.color}"></span>${person.name}</span>
        `).join("")}
      </div>
    </article>
  `).join("");
}

function renderNotifications() {
  if (!state.notifications.length) {
    notificationList.innerHTML = `<div class="empty-state">When someone uploads a schedule, matching classmates get alerts here.</div>`;
    return;
  }

  notificationList.innerHTML = state.notifications.slice(0, 8).map((note) => `
    <article class="notification-card">
      <p><strong>${note.message}</strong></p>
      <p class="subtext">${new Date(note.createdAt).toLocaleString()}</p>
    </article>
  `).join("");
}

function render() {
  const person = selectedPerson();
  if (!person) {
    selectedName.textContent = "Add your first friend";
    draftClasses = [];
    renderFriends();
    renderClasses();
    renderMatches();
    renderNotifications();
    return;
  }
  selectedId = person.id;
  selectedName.textContent = person.name;
  renderFriends();
  renderClasses();
  renderMatches();
  renderNotifications();
}

async function loadState() {
  state = await api("/api/state");
  selectedId = selectedId || state.people[0]?.id;
  draftClasses = [...(selectedPerson()?.classes || [])];
  render();
}

function addDraftClass(klass) {
  if (!klass.course) return;
  draftClasses.push(klass);
  renderClasses();
}

function wireEvents() {
  document.querySelectorAll(".segment").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".segment").forEach((item) => item.classList.remove("active"));
      document.querySelectorAll(".upload-mode").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      $(`#${button.dataset.mode}Mode`).classList.add("active");
    });
  });

  $("#addClassBtn").addEventListener("click", () => {
    addDraftClass({
      course: $("#courseInput").value.trim().toUpperCase(),
      title: $("#titleInput").value.trim(),
      teacher: $("#teacherInput").value.trim(),
      room: $("#roomInput").value.trim(),
      days: parseDays($("#daysInput").value),
      start: $("#startInput").value.trim(),
      end: $("#endInput").value.trim()
    });

    ["#courseInput", "#titleInput", "#teacherInput", "#roomInput", "#daysInput", "#startInput", "#endInput"].forEach((id) => {
      $(id).value = "";
    });
  });

  $("#importCsvBtn").addEventListener("click", () => {
    draftClasses = csvToClasses($("#csvInput").value);
    renderClasses();
    setStatus(`Imported ${draftClasses.length} classes`);
  });

  $("#imageInput").addEventListener("change", (event) => {
    selectedImage = event.target.files[0] || null;
    setStatus(selectedImage ? selectedImage.name : "Ready");
  });

  $("#scanBtn").addEventListener("click", async () => {
    if (!selectedImage) {
      setStatus("Choose an image first");
      return;
    }

    setStatus("Scanning image...");
    const imageBase64 = await fileToBase64(selectedImage);
    const result = await api("/api/scan", {
      method: "POST",
      body: JSON.stringify({
        imageBase64,
        mimeType: selectedImage.type
      })
    });
    draftClasses = result.classes || [];
    renderClasses();
    setStatus(result.demo ? "Demo scan loaded" : "Image scanned");
  });

  $("#saveScheduleBtn").addEventListener("click", async () => {
    const person = selectedPerson();
    if (!person) return;
    setStatus("Saving...");
    const payload = await api("/api/schedules", {
      method: "POST",
      body: JSON.stringify({ personId: person.id, classes: draftClasses })
    });
    state.people = state.people.map((item) => item.id === payload.person.id ? payload.person : item);
    state.matches = payload.matches;
    state.notifications = payload.notifications;
    setStatus("Saved and matched");
    render();
  });

  $("#openAddFriend").addEventListener("click", () => {
    $("#friendDialog").showModal();
  });

  document.querySelectorAll(".swatch").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".swatch").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      selectedColor = button.dataset.color;
    });
  });

  $("#createFriendBtn").addEventListener("click", async () => {
    const name = $("#friendNameInput").value.trim();
    if (!name) return;
    const result = await api("/api/people", {
      method: "POST",
      body: JSON.stringify({ name, color: selectedColor })
    });
    state.people.push(result.person);
    state.matches = result.matches;
    selectedId = result.person.id;
    draftClasses = [];
    $("#friendNameInput").value = "";
    $("#friendDialog").close();
    render();
  });

  $("#renameFriendBtn").addEventListener("click", () => {
    const person = selectedPerson();
    if (!person) return;
    $("#renameInput").value = person.name;
    $("#renameDialog").showModal();
  });

  $("#saveRenameBtn").addEventListener("click", async () => {
    const person = selectedPerson();
    const name = $("#renameInput").value.trim();
    if (!person || !name) return;

    const payload = await api(`/api/people/${encodeURIComponent(person.id)}`, {
      method: "PUT",
      body: JSON.stringify({ name })
    });
    state.people = payload.people;
    state.matches = payload.matches;
    state.notifications = payload.notifications;
    $("#renameDialog").close();
    setStatus("Friend renamed");
    render();
  });

  $("#deleteFriendBtn").addEventListener("click", async () => {
    const person = selectedPerson();
    if (!person) return;
    const shouldDelete = window.confirm(`Delete ${person.name} and their schedule?`);
    if (!shouldDelete) return;

    const payload = await api(`/api/people/${encodeURIComponent(person.id)}`, {
      method: "DELETE"
    });
    state.people = payload.people;
    state.matches = payload.matches;
    state.notifications = payload.notifications;
    selectedId = state.people[0]?.id || null;
    draftClasses = [...(selectedPerson()?.classes || [])];
    setStatus("Friend deleted");
    render();
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

wireEvents();
loadState().catch((error) => {
  setStatus(error.message);
});
