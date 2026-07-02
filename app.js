let state = {
  activeGroup: null,
  people: [],
  matches: [],
  notifications: []
};

let selectedId = null;
let selectedColor = "#2f80ed";
let draftClasses = [];
let selectedImage = null;
let activeGroupId = localStorage.getItem("scheduleSyncGroupId") || "";
let knownGroups = loadKnownGroups();

const $ = (selector) => document.querySelector(selector);
const friendList = $("#friendList");
const selectedName = $("#selectedName");
const classTable = $("#classTable");
const matchList = $("#matchList");
const notificationList = $("#notificationList");
const scanStatus = $("#scanStatus");
const groupName = $("#groupName");
const groupSelect = $("#groupSelect");
const groupCodeText = $("#groupCodeText");
const withMeList = $("#withMeList");
const calendarGrid = $("#calendarGrid");
const intakePanel = document.querySelector(".schedule-panel");

function selectedPerson() {
  return state.people.find((person) => person.id === selectedId) || state.people[0];
}

function hasSelectedPerson() {
  return Boolean(selectedPerson());
}

function setStatus(message) {
  scanStatus.textContent = message;
}

function loadKnownGroups() {
  try {
    return JSON.parse(localStorage.getItem("scheduleSyncKnownGroups") || "[]");
  } catch {
    return [];
  }
}

function saveKnownGroups() {
  localStorage.setItem("scheduleSyncKnownGroups", JSON.stringify(knownGroups));
}

function rememberGroup(group) {
  if (!group?.id) return;
  const existingIndex = knownGroups.findIndex((item) => item.id === group.id);
  if (existingIndex >= 0) {
    knownGroups[existingIndex] = group;
  } else {
    knownGroups.push(group);
  }
  saveKnownGroups();
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

function compactText(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
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

function classIdentity(klass) {
  const text = compactText(`${klass.course} ${klass.title}`);
  const courseMatch = text.match(/\b([A-Z]{2,8})\s*([0-9][A-Z0-9]{2,4})\b/);
  const sectionMatch = text.match(/\b([CLT][0-9]{2,3})\b/);

  return {
    courseCode: courseMatch ? `${courseMatch[1]} ${courseMatch[2]}` : compactText(klass.course),
    section: sectionMatch ? sectionMatch[1] : "",
    room: compactText(klass.room),
    start: normalizeTime(klass.start),
    end: normalizeTime(klass.end)
  };
}

function sameClass(left, right) {
  const a = classIdentity(left);
  const b = classIdentity(right);
  if (!a.courseCode || a.courseCode !== b.courseCode) return false;

  const sameSection = a.section && b.section && a.section === b.section;
  const sameTime = a.start && b.start && a.end && b.end && a.start === b.start && a.end === b.end;
  const sameRoom = a.room && b.room && a.room === b.room;

  return sameSection || sameTime || (sameRoom && sameTime);
}

function classmatesForClass(klass) {
  const person = selectedPerson();
  if (!person) return [];

  const classmates = new Map();
  for (const match of state.matches || []) {
    const selectedIsInMatch = match.people.some((member) => member.id === person.id);
    if (!selectedIsInMatch || !sameClass(klass, match.classInfo)) continue;

    for (const member of match.people) {
      if (member.id !== person.id) classmates.set(member.id, member);
    }
  }

  return [...classmates.values()];
}

function renderClassmateLine(klass) {
  const classmates = classmatesForClass(klass);
  if (!classmates.length) return `<div class="classmates-line muted-with">No friends in this class yet</div>`;

  return `
    <div class="classmates-line">
      <span class="with-label">With</span>
      ${classmates.map((person) => `
        <span class="mini-chip"><span class="chip-dot" style="background:${person.color}"></span>${person.name}</span>
      `).join("")}
    </div>
  `;
}

function renderGroups() {
  const optionGroups = [...knownGroups];
  if (state.activeGroup && !optionGroups.some((group) => group.id === state.activeGroup.id)) {
    optionGroups.push(state.activeGroup);
  }

  groupSelect.innerHTML = optionGroups.length
    ? optionGroups.map((group) => `
        <option value="${group.id}" ${group.id === state.activeGroup?.id ? "selected" : ""}>${group.name}</option>
      `).join("")
    : `<option value="">No private group selected</option>`;
  groupName.textContent = state.activeGroup?.name || "No group";
  groupCodeText.textContent = state.activeGroup ? `Invite code: ${state.activeGroup.code}` : "Create a group or join with a code.";
}

function setIntakeLocked(isLocked) {
  intakePanel?.classList.toggle("locked", isLocked);
  [
    "#imageInput",
    "#scanBtn",
    "#courseInput",
    "#titleInput",
    "#teacherInput",
    "#roomInput",
    "#daysInput",
    "#startInput",
    "#endInput",
    "#addClassBtn",
    "#csvInput",
    "#importCsvBtn",
    "#saveScheduleBtn"
  ].forEach((selector) => {
    const element = $(selector);
    if (element) element.disabled = isLocked;
  });
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

function sharedMatchesForSelected() {
  const person = selectedPerson();
  if (!person) return [];

  return (state.matches || [])
    .filter((match) => match.people.some((member) => member.id === person.id))
    .map((match) => ({
      ...match,
      classmates: match.people.filter((member) => member.id !== person.id)
    }))
    .filter((match) => match.classmates.length);
}

function renderWithMe() {
  const matches = sharedMatchesForSelected();
  if (!matches.length) {
    withMeList.innerHTML = `<div class="empty-state">No shared classes in this group yet.</div>`;
    return;
  }

  withMeList.innerHTML = matches.map((match) => `
    <article class="with-me-card">
      <div>
        <h4>You have ${match.classInfo.course} with ${match.classmates.map((person) => person.name).join(", ")}</h4>
        <p class="subtext">${match.classInfo.title || "Class"} - ${match.classInfo.start || "--:--"} to ${match.classInfo.end || "--:--"} - ${(match.classInfo.days || []).join(" ")}</p>
      </div>
      <div class="people-chips">
        ${match.classmates.map((person) => `
          <span class="chip"><span class="chip-dot" style="background:${person.color}"></span>${person.name}</span>
        `).join("")}
      </div>
    </article>
  `).join("");
}

function dayMatches(day, klass) {
  return (klass.days || []).some((item) => item.toLowerCase().startsWith(day.toLowerCase().slice(0, 3)));
}

function renderCalendar() {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const classes = [...draftClasses].sort((a, b) => String(a.start).localeCompare(String(b.start)));

  calendarGrid.innerHTML = days.map((day) => {
    const dayClasses = classes.filter((klass) => dayMatches(day, klass));
    return `
      <section class="calendar-day">
        <h4>${day}</h4>
        <div class="calendar-day-stack">
          ${dayClasses.length ? dayClasses.map((klass) => {
            const classmates = classmatesForClass(klass);
            return `
              <article class="calendar-class ${classmates.length ? "shared" : ""}">
                <strong>${klass.course}</strong>
                <span>${klass.start || "--:--"} - ${klass.end || "--:--"}</span>
                <small>${klass.title || "Class"}</small>
                ${classmates.length ? `<em>With ${classmates.map((person) => person.name).join(", ")}</em>` : ""}
              </article>
            `;
          }).join("") : `<div class="calendar-empty">No classes</div>`}
        </div>
      </section>
    `;
  }).join("");
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
        ${renderClassmateLine(klass)}
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
    selectedName.textContent = state.activeGroup ? "Add your first friend" : "Join or create a private group";
    draftClasses = [];
    renderGroups();
    setIntakeLocked(true);
    renderFriends();
    renderClasses();
    renderMatches();
    renderNotifications();
    renderWithMe();
    renderCalendar();
    return;
  }
  selectedId = person.id;
  selectedName.textContent = person.name;
  renderGroups();
  setIntakeLocked(false);
  renderFriends();
  renderClasses();
  renderMatches();
  renderNotifications();
  renderWithMe();
  renderCalendar();
}

async function loadState() {
  const query = activeGroupId ? `?groupId=${encodeURIComponent(activeGroupId)}` : "";
  state = await api(`/api/state${query}`);
  if (!state.activeGroup && activeGroupId && knownGroups.length) {
    knownGroups = knownGroups.filter((group) => group.id !== activeGroupId);
    saveKnownGroups();
    activeGroupId = knownGroups[0]?.id || "";
    if (activeGroupId) return loadState();
  }
  activeGroupId = state.activeGroup?.id || "";
  if (activeGroupId) {
    localStorage.setItem("scheduleSyncGroupId", activeGroupId);
    rememberGroup(state.activeGroup);
  } else {
    localStorage.removeItem("scheduleSyncGroupId");
  }
  selectedId = selectedId || state.people[0]?.id;
  if (!state.people.some((person) => person.id === selectedId)) selectedId = state.people[0]?.id || null;
  draftClasses = [...(selectedPerson()?.classes || [])];
  render();
}

function addDraftClass(klass) {
  if (!klass.course) return;
  draftClasses.push(klass);
  renderClasses();
}

function switchView(viewName) {
  document.querySelectorAll(".view-tab").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === viewName);
  });

  document.querySelectorAll(".app-view").forEach((item) => {
    const isActive = item.id === `${viewName}View`;
    item.classList.toggle("active", isActive);
    item.hidden = !isActive;
  });
}

function wireEvents() {
  document.querySelectorAll(".view-tab").forEach((button) => {
    button.addEventListener("click", () => {
      switchView(button.dataset.view);
      document.querySelector(".workspace").scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  groupSelect.addEventListener("change", async () => {
    if (!groupSelect.value) return;
    activeGroupId = groupSelect.value;
    localStorage.setItem("scheduleSyncGroupId", activeGroupId);
    selectedId = null;
    await loadState();
  });

  $("#copyGroupCodeBtn").addEventListener("click", async () => {
    if (!state.activeGroup) return;
    try {
      await navigator.clipboard.writeText(state.activeGroup.code);
      setStatus("Group code copied");
    } catch {
      setStatus(`Code: ${state.activeGroup.code}`);
    }
  });

  $("#openCreateGroup").addEventListener("click", () => {
    $("#createGroupDialog").showModal();
  });

  $("#openJoinGroup").addEventListener("click", () => {
    $("#joinGroupDialog").showModal();
  });

  $("#createGroupBtn").addEventListener("click", async () => {
    const name = $("#groupNameInput").value.trim();
    if (!name) return;
    const payload = await api("/api/groups", {
      method: "POST",
      body: JSON.stringify({ name })
    });
    rememberGroup(payload.group);
    activeGroupId = payload.group.id;
    localStorage.setItem("scheduleSyncGroupId", activeGroupId);
    selectedId = null;
    $("#groupNameInput").value = "";
    $("#createGroupDialog").close();
    await loadState();
    setStatus(`Created ${payload.group.name}`);
  });

  $("#joinGroupBtn").addEventListener("click", async () => {
    const code = $("#joinCodeInput").value.trim();
    if (!code) return;
    const payload = await api("/api/groups/join", {
      method: "POST",
      body: JSON.stringify({ code })
    });
    rememberGroup(payload.group);
    activeGroupId = payload.group.id;
    localStorage.setItem("scheduleSyncGroupId", activeGroupId);
    selectedId = null;
    $("#joinCodeInput").value = "";
    $("#joinGroupDialog").close();
    await loadState();
    setStatus(`Joined ${payload.group.name}`);
  });

  document.querySelectorAll(".segment").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".segment").forEach((item) => item.classList.remove("active"));
      document.querySelectorAll(".upload-mode").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      $(`#${button.dataset.mode}Mode`).classList.add("active");
    });
  });

  $("#addClassBtn").addEventListener("click", () => {
    if (!hasSelectedPerson()) {
      setStatus("Add a friend first");
      return;
    }
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
    if (!hasSelectedPerson()) {
      setStatus("Add a friend first");
      return;
    }
    draftClasses = csvToClasses($("#csvInput").value);
    renderClasses();
    setStatus(`Imported ${draftClasses.length} classes`);
  });

  $("#imageInput").addEventListener("change", (event) => {
    if (!hasSelectedPerson()) {
      event.target.value = "";
      selectedImage = null;
      setStatus("Add a friend first");
      return;
    }
    selectedImage = event.target.files[0] || null;
    setStatus(selectedImage ? selectedImage.name : "Ready");
  });

  $("#scanBtn").addEventListener("click", async () => {
    if (!hasSelectedPerson()) {
      setStatus("Add a friend first");
      return;
    }
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
    if (!person) {
      setStatus("Add a friend first");
      return;
    }
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
    if (!state.activeGroup) {
      setStatus("Create or join a group first");
      return;
    }
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
      body: JSON.stringify({ name, color: selectedColor, groupId: activeGroupId })
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

    await api(`/api/people/${encodeURIComponent(person.id)}`, {
      method: "DELETE"
    });
    selectedId = state.people[0]?.id || null;
    await loadState();
    setStatus("Friend deleted");
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
switchView("schedule");
loadState().catch((error) => {
  setStatus(error.message);
});
