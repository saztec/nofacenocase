/* NoFaceNoCase — patient registry.
   All four CRUD ops against the fake API:
   read → apiGetPatients() · add → apiCreatePatient()
   edit → apiUpdatePatient() · remove → apiDeletePatient()          */

const user = requireLogin();
document.getElementById("userName").textContent = user.name;
document.getElementById("userRole").textContent = user.role;

let allPatients = [];
let patientData = {};  // patientId → { checkins, state, urgency } — the mood + triage stuff
let editingId = null; // null = creating, otherwise the patientId being edited

const registryBody = document.getElementById("registryBody");
const searchBox = document.getElementById("searchBox");
const modal = document.getElementById("patientModal");
const patientForm = document.getElementById("patientForm");
const toast = document.getElementById("toast");

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2600);
}

/* read */
async function loadRegistry() {
  const res = await apiGetPatients(); // mock SELECT * FROM patients
  allPatients = res.patients;
  await loadStates();                 // one pass: check-ins + derived mood state
  renderRegistry();
  renderWardMood();
  updateStats();
}

/* pull every patient's check-ins once and work out their state up front, so
   the registry, ward bar and stats all share one cache */
async function loadStates() {
  patientData = {};
  for (const p of allPatients) {
    const res = await apiGetCheckins(p.patientId);
    patientData[p.patientId] = {
      checkins: res.checkins,
      state: moodStateFor(res.checkins),
      urgency: urgencyFor(p, res.checkins)   // triage level, for sorting + the assist flag
    };
  }
}

function renderRegistry() {
  const q = searchBox.value.trim().toLowerCase();
  const statusFilter = (document.getElementById("statusFilter") || {}).value || "all";
  const sortBy = (document.getElementById("sortBy") || {}).value || "urgent";

  let rows = allPatients.filter((p) =>
    !q || p.name.toLowerCase().includes(q) || p.patientId.toLowerCase().includes(q) || p.ward.toLowerCase().includes(q)
  );
  if (statusFilter !== "all") {
    rows = rows.filter((p) => (p.status || "Admitted") === statusFilter);
  }

  // sort — default is distress/urgency order (most urgent first)
  const urg = (id) => (patientData[id] && patientData[id].urgency ? patientData[id].urgency.score : 0);
  if (sortBy === "urgent") {
    rows.sort((a, b) => urg(b.patientId) - urg(a.patientId) || a.name.localeCompare(b.name));
  } else if (sortBy === "name") {
    rows.sort((a, b) => a.name.localeCompare(b.name));
  } else if (sortBy === "id") {
    rows.sort((a, b) => a.patientId.localeCompare(b.patientId));
  }

  if (rows.length === 0) {
    registryBody.innerHTML = `<tr><td colspan="6" class="muted">No patients match. Try a different search or filter, or register a new patient.</td></tr>`;
    return;
  }

  registryBody.innerHTML = rows.map((p) => {
    const d = patientData[p.patientId] || {};
    const s = d.state || moodStateFor([]);
    const u = d.urgency || { key: "routine", label: "Routine", needsAssist: false };
    const status = p.status || "Admitted";
    const discharged = status === "Discharged";

    const moodBadge = `<span class="mood-badge mood-${s.key}">${s.label}${s.score ? " · " + s.score + "/10" : ""}</span>`;
    const assistPill = u.needsAssist ? `<span class="assist-pill urgency-${u.key}">Needs assistance · ${u.label}</span>` : "";
    const statusChip = `<span class="status-chip status-${status.toLowerCase()}">${status}</span>`;

    return `
    <tr class="mood-row mood-${s.key}${discharged ? " is-discharged" : ""}">
      <td>
        <strong>${p.name}</strong> ${statusChip}<br />
        <span class="muted" style="font-size:0.78rem">${p.condition}</span>
        <div class="row-signals">${moodBadge}${assistPill}</div>
      </td>
      <td class="pid">${p.patientId}</td>
      <td>${p.age}</td>
      <td>${p.ward}</td>
      <td>${p.clinician}</td>
      <td>
        <div class="actions">
          <a class="btn btn-primary btn-sm" href="patient.html?id=${p.patientId}">View trends</a>
          <a class="btn btn-ghost btn-sm" href="checkin.html?id=${p.patientId}">Check-in</a>
          <button class="btn btn-ghost btn-sm" onclick="openEdit('${p.patientId}')">Edit</button>
          ${discharged
            ? `<button class="btn btn-ghost btn-sm" onclick="setStatus('${p.patientId}','Admitted')">Re-admit</button>`
            : `<button class="btn btn-ghost btn-sm" onclick="dischargePatient('${p.patientId}')">Discharge</button>`}
          ${user.role === "clinician" ? `<button class="btn btn-danger btn-sm" onclick="removePatient('${p.patientId}')">Delete</button>` : ""}
        </div>
      </td>
    </tr>`;
  }).join("");
}

function updateStats() {
  document.getElementById("statPatients").textContent = allPatients.length;
  // tally check-ins + alerts from the cache
  let checkins = 0, alerts = 0;
  for (const id in patientData) {
    checkins += patientData[id].checkins.length;
    alerts += patientData[id].checkins.filter((c) => c.alertSent).length;
  }
  document.getElementById("statCheckins").textContent = checkins;
  document.getElementById("statAlerts").textContent = alerts;
}

/* ward mood */
/* roll everyone's state into the distribution bar and tint the ward card +
   page wash toward the worst state on the ward */
const WARD_STATE_ORDER = ["distress", "low", "steady", "thriving", "none"];
function renderWardMood() {
  const states = allPatients.map((p) => patientData[p.patientId].state);
  const summary = wardMoodSummary(states);
  const card = document.getElementById("wardMoodCard");

  // theme the ward card + whole page toward the dominant (most urgent) state
  const moodClasses = WARD_STATE_ORDER.map((k) => "mood-" + k);
  card.classList.remove(...moodClasses);
  card.classList.add("mood-" + summary.dominant);
  document.body.classList.remove("mood-ward", ...moodClasses);
  document.body.classList.add("mood-ward", "mood-" + summary.dominant);

  const dominantLabel = MOOD_STATES[summary.dominant].label;
  document.getElementById("wardDominant").textContent =
    summary.dominant === "distress"
      ? `${summary.counts.distress} patient${summary.counts.distress === 1 ? "" : "s"} need attention`
      : `Ward reads ${dominantLabel.toLowerCase()}`;

  // segmented bar — one flex segment per state, sized by count
  const segs = WARD_STATE_ORDER.filter((k) => summary.counts[k] > 0);
  document.getElementById("wardBar").innerHTML = segs.map((k) =>
    `<div class="ward-seg mood-${k}" style="flex-grow:${summary.counts[k]}" title="${MOOD_STATES[k].label}: ${summary.counts[k]}"></div>`
  ).join("");

  // legend with counts
  document.getElementById("wardLegend").innerHTML = WARD_STATE_ORDER
    .filter((k) => summary.counts[k] > 0)
    .map((k) => `<span class="key mood-${k}">${MOOD_STATES[k].label} <strong>${summary.counts[k]}</strong></span>`)
    .join("");
}

searchBox.addEventListener("input", renderRegistry);
["statusFilter", "sortBy"].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("change", renderRegistry);
});

/* status / discharge */
window.setStatus = async function (patientId, status) {
  await apiUpdatePatient(patientId, { status });   // mock UPDATE
  showToast(`Patient ${patientId} → ${status}`);
  loadRegistry();
};

window.dischargePatient = async function (patientId) {
  const p = allPatients.find((x) => x.patientId === patientId);
  const ok = confirm(`Discharge ${p.name} (${patientId})?\nThe record stays on file and can be re-admitted.`);
  if (!ok) return;
  await apiUpdatePatient(patientId, { status: "Discharged" });
  showToast(`Patient ${patientId} discharged`);
  loadRegistry();
};

/* add / edit */
document.getElementById("addPatientBtn").addEventListener("click", () => {
  editingId = null;
  patientForm.reset();
  document.getElementById("modalTitle").textContent = "Register patient";
  document.getElementById("modalSub").textContent = "Creates a new record in the patient database.";
  document.getElementById("modalSave").textContent = "Save patient";
  modal.classList.remove("hidden");
});

window.openEdit = function (patientId) {
  const p = allPatients.find((x) => x.patientId === patientId);
  if (!p) return;
  editingId = patientId;
  document.getElementById("pName").value = p.name;
  document.getElementById("pAge").value = p.age;
  document.getElementById("pWard").value = p.ward;
  document.getElementById("pCondition").value = p.condition;
  document.getElementById("pClinician").value = p.clinician;
  const pStatus = document.getElementById("pStatus");
  if (pStatus) pStatus.value = p.status || "Admitted";
  document.getElementById("modalTitle").textContent = "Edit patient " + patientId;
  document.getElementById("modalSub").textContent = "Updates the existing record in the patient database.";
  document.getElementById("modalSave").textContent = "Save changes";
  modal.classList.remove("hidden");
};

document.getElementById("modalCancel").addEventListener("click", () => modal.classList.add("hidden"));
modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });

patientForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = {
    name: document.getElementById("pName").value.trim(),
    age: parseInt(document.getElementById("pAge").value, 10),
    ward: document.getElementById("pWard").value,
    condition: document.getElementById("pCondition").value.trim(),
    clinician: document.getElementById("pClinician").value,
    status: (document.getElementById("pStatus") || {}).value || "Admitted",
    admitted: new Date().toISOString().slice(0, 10)
  };
  if (!data.name || !data.age || !data.condition) {
    showToast("Fill in name, age and condition before saving.");
    return;
  }

  const saveBtn = document.getElementById("modalSave");
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<span class="spin"></span> Saving…';

  if (editingId) {
    await apiUpdatePatient(editingId, data);   // mock UPDATE
    showToast("Patient " + editingId + " updated");
  } else {
    const res = await apiCreatePatient(data);  // mock INSERT
    showToast("Patient " + res.patient.patientId + " registered");
  }

  saveBtn.disabled = false;
  saveBtn.textContent = "Save patient";
  modal.classList.add("hidden");
  loadRegistry();
});

/* remove */
window.removePatient = async function (patientId) {
  const p = allPatients.find((x) => x.patientId === patientId);
  const ok = confirm(`Delete ${p.name} (${patientId})?\nThis removes the patient record and all check-in history.`);
  if (!ok) return;
  await apiDeletePatient(patientId); // mock DELETE
  showToast("Patient " + patientId + " deleted");
  loadRegistry();
};

loadRegistry();
