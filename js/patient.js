/* NoFaceNoCase — patient trends page.
   Grabs one patient + their check-ins and draws the wellness-pulse chart by
   hand (no chart library, so it always matches the rest of the app). */

const user = requireLogin();
document.getElementById("userName").textContent = user.name;
document.getElementById("userRole").textContent = user.role;

const params = new URLSearchParams(window.location.search);
const patientId = params.get("id");

if (!patientId) window.location.href = "dashboard.html";
document.getElementById("checkinLink").href = "checkin.html?id=" + patientId;

const SENTIMENT_CHIP = {
  POSITIVE: "chip-pos", NEGATIVE: "chip-neg", MIXED: "chip-mixed", NEUTRAL: "chip-neutral"
};

/* hoisted so the bed-check flow below can read/update the current patient
   and recompute triage without a full page reload */
let currentPatient = null;
let currentCheckins = [];

async function init() {
  const pRes = await apiGetPatient(patientId);   // mock SELECT ... WHERE id
  if (!pRes.success) {
    document.getElementById("patientName").textContent = "Patient not found";
    return;
  }
  currentPatient = pRes.patient;
  const p = currentPatient;
  document.getElementById("patientId").textContent = p.patientId + " · " + p.ward;
  document.getElementById("patientName").textContent = p.name;
  document.getElementById("patientMeta").textContent =
    `${p.age} years · ${p.condition} · ${p.status || "Admitted"} · Assigned to ${p.clinician} · Admitted ${p.admitted}`;

  const cRes = await apiGetCheckins(patientId);   // mock SELECT check-ins
  const mRes = await apiGetMedications(patientId); // mock SELECT medications
  currentCheckins = cRes.checkins;

  const state = renderStateHero(currentCheckins, p);
  const urgency = urgencyFor(p, currentCheckins);
  const prediction = predictNextMood(currentCheckins);

  renderUrgent(urgency, p);
  renderTriage(urgency);
  renderChart(currentCheckins, state);
  renderPrediction(prediction);
  renderMonitoring(p);
  renderMeds(currentCheckins, mRes.medications);
  renderFeed(currentCheckins);
}

/* re-paints just the signals that depend on currentPatient — used after the
   bed check updates monitoring, so the page reflects it without a reload */
function refreshCareSignals() {
  const urgency = urgencyFor(currentPatient, currentCheckins);
  renderUrgent(urgency, currentPatient);
  renderTriage(urgency);
  renderMonitoring(currentPatient);
}

/* urgent pulsing banner */
/* only pops up at Priority/Critical. the pulse is a slow (~0.5Hz) fade, way
   under the 3-flashes-a-second seizure limit, and CSS kills it entirely if
   the user's asked for reduced motion. */
function renderUrgent(u, p) {
  const box = document.getElementById("urgentBanner");
  if (!u || u.level < 2) { box.innerHTML = ""; return; }
  box.innerHTML = `
    <div class="urgent-banner urgency-${u.key}" role="alert" aria-live="assertive">
      <span class="urgent-pulse" aria-hidden="true"></span>
      <div>
        <strong>${u.needsAssist ? "Assistance needed" : "Attention"} · ${u.label}</strong>
        <div class="urgent-detail">${u.reasons.slice(0, 3).join(" · ")}. Assigned clinician: ${p.clinician}.</div>
      </div>
    </div>`;
}

/* care triage card */
function renderTriage(u) {
  const box = document.getElementById("triagePanel");
  const pct = Math.min(100, Math.round((u.score / 6) * 100));
  box.innerHTML = `
    <section class="card urgency-${u.key}">
      <p class="eyebrow">Care triage</p>
      <div class="triage-head">
        <div>
          <h2 class="section-title" style="margin:0">Assistance urgency · ${u.label}</h2>
          <p class="muted" style="font-size:0.85rem; margin-top:4px">
            ${u.needsAssist ? "Signals suggest this patient needs staff assistance now." : "No immediate assistance flagged."}
          </p>
        </div>
        <span class="triage-level urgency-${u.key}">${u.label}</span>
      </div>
      <div class="triage-meter" role="img" aria-label="Urgency ${pct} percent"><span style="width:${pct}%"></span></div>
      <ul class="triage-reasons">
        ${u.reasons.length ? u.reasons.map((r) => `<li>${r}</li>`).join("") : "<li>All monitored signals within normal range.</li>"}
      </ul>
    </section>`;
}

/* mood prediction */
function renderPrediction(pred) {
  const box = document.getElementById("predictionNote");
  if (!pred) { box.innerHTML = ""; return; }
  const arrow = pred.trend === "improving" ? "↗" : pred.trend === "declining" ? "↘" : "→";
  box.innerHTML = `
    <div class="prediction-chip trend-${pred.trend}">
      <span class="pred-arrow" aria-hidden="true">${arrow}</span>
      <span>Projected next check-in ≈ <strong>${pred.value}/10</strong> · trend ${pred.trend}</span>
      <span class="muted" style="font-size:0.72rem">from last ${pred.basis} check-ins</span>
    </div>`;
}

/* sleep & movement */
function renderMonitoring(p) {
  const m = p.monitoring;
  const box = document.getElementById("monitorPanel");
  if (!m) { box.innerHTML = ""; return; }

  const sleepPct = Math.min(100, Math.round((m.sleepHours / 10) * 100));
  const totalAct = (m.dayActiveHrs || 0) + (m.nightActiveHrs || 0) || 1;
  const dayPct = Math.round((m.dayActiveHrs / totalAct) * 100);
  const alarmExits = m.bedExitsNight >= 4;

  box.innerHTML = `
    <section class="card">
      <p class="eyebrow">Monitoring · last 24 hours</p>
      <h2 class="section-title">Sleep &amp; movement</h2>
      <div class="monitor-grid">
        <div class="monitor-tile">
          <div class="mt-label">Sleep last night</div>
          <div class="mt-value">${m.sleepHours}h <small>${m.sleepQuality}</small></div>
          <div class="mt-bar"><span style="width:${sleepPct}%"></span></div>
        </div>
        <div class="monitor-tile">
          <div class="mt-label">Movement</div>
          <div class="mt-value">${m.movement}</div>
          <div class="mt-sub">Daytime activity level</div>
        </div>
        <div class="monitor-tile">
          <div class="mt-label">Overnight bed exits</div>
          <div class="mt-value ${alarmExits ? "mt-alarm" : ""}">${m.bedExitsNight}</div>
          <div class="mt-sub">${m.highRisk ? "High-risk · fall / wandering" : "Within expected range"}</div>
        </div>
      </div>
      <div class="daynight">
        <div class="dn-head"><span>Activity by time of day</span><span class="muted">Day ${m.dayActiveHrs}h · Night ${m.nightActiveHrs}h</span></div>
        <div class="dn-bar">
          <span class="dn-day" style="width:${dayPct}%">Day</span>
          <span class="dn-night" style="width:${100 - dayPct}%">Night</span>
        </div>
      </div>
      <p class="hint">Sleep, movement and bed-exit figures from bed/motion sensors and camera analysis.</p>
    </section>`;
}

/* medication response thingy */
function renderMeds(checkins, meds) {
  const box = document.getElementById("medsPanel");
  if (!meds || meds.length === 0) { box.innerHTML = ""; return; }
  const rows = medsResponse(checkins, meds);

  box.innerHTML = `
    <section class="card">
      <p class="eyebrow">Medication response</p>
      <h2 class="section-title">Mood before vs after medication</h2>
      <div class="meds-list">
        ${rows.map((r) => {
          const b = r.before != null ? r.before.toFixed(1) : "–";
          const a = r.after != null ? r.after.toFixed(1) : "–";
          const dir = r.delta == null ? "flat" : r.delta > 0 ? "up" : r.delta < 0 ? "down" : "flat";
          const deltaTxt = r.delta == null ? "n/a" : (r.delta > 0 ? "+" : "") + r.delta;
          return `
          <div class="med-row">
            <div class="med-name">${r.med.name}
              <div class="muted" style="font-size:0.76rem">Started ${r.med.date}${r.med.by ? " · " + r.med.by : ""}</div>
            </div>
            <div class="med-ba">
              <span class="med-stat"><small>before</small>${b}</span>
              <span class="med-arrow ${dir}" aria-hidden="true">→</span>
              <span class="med-stat"><small>after</small>${a}</span>
            </div>
            <span class="med-delta ${dir}">${deltaTxt}</span>
          </div>`;
        }).join("")}
      </div>
      <p class="hint">Average mood across check-ins before vs on/after the start date — a rough heuristic for now.</p>
    </section>`;
}

/* work out the patient's current state, paint the whole page with it, and drop
   a "current wellbeing" hero that shifts colour/copy/score to match */
function renderStateHero(checkins, p) {
  const s = moodStateFor(checkins);

  // theme the page: ambient wash + accent tint keyed to this patient's mood
  document.body.classList.remove("mood-distress", "mood-low", "mood-steady", "mood-thriving", "mood-none");
  document.body.classList.add("mood-page", "mood-" + s.key);

  const recentAlert = [...checkins].reverse().find((c) => c.alertSent);
  let detail;
  if (s.key === "none") {
    detail = "No check-ins recorded yet — record the first to establish a baseline.";
  } else if (s.key === "distress") {
    detail = `Latest check-in on ${s.latest.date} read ${s.latest.emotion.Type} at ${s.latest.emotion.Confidence.toFixed(0)}% with a mood of ${s.score}/10.` +
             (recentAlert ? ` An SNS distress alert was sent to ${p.clinician}.` : "");
  } else {
    detail = `Latest on ${s.latest.date}: mood ${s.score}/10, ${s.latest.emotion.Type} (${s.latest.emotion.Confidence.toFixed(0)}%), note sentiment ${s.latest.sentiment.toLowerCase()}.`;
  }

  document.getElementById("alertBanner").innerHTML = `
    <div class="state-hero mood-${s.key}" role="${s.key === "distress" ? "alert" : "status"}">
      <span class="state-dot"></span>
      <div>
        <div class="state-label">Current wellbeing · ${s.label}</div>
        <div class="state-detail">${detail}</div>
      </div>
      ${s.score ? `<span class="state-score">${s.score}<small>/10</small></span>` : ""}
    </div>`;
  return s;
}

/* the hand-drawn chart */
function renderChart(checkins, state) {
  const wrap = document.getElementById("chartWrap");
  if (checkins.length === 0) {
    wrap.innerHTML = `<p class="muted">No check-ins recorded yet. Record the first check-in to start this patient's wellness trend.</p>`;
    return;
  }
  // the trend line takes on the patient's current mood colour
  const line = (state && state.hex) || "#2f5d4c";

  const W = 720, H = 240, PAD = { l: 36, r: 16, t: 16, b: 34 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const n = checkins.length;
  const x = (i) => PAD.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (mood) => PAD.t + ih - ((mood - 1) / 9) * ih; // mood scale 1–10

  // Grid lines + y labels at mood 2,4,6,8,10
  let grid = "";
  for (const m of [2, 4, 6, 8, 10]) {
    grid += `<line x1="${PAD.l}" y1="${y(m)}" x2="${W - PAD.r}" y2="${y(m)}" stroke="#e8dfcb" stroke-width="1"/>
             <text x="${PAD.l - 8}" y="${y(m) + 4}" text-anchor="end" font-size="10" fill="#a99f88">${m}</text>`;
  }

  const pts = checkins.map((c, i) => ({ cx: x(i), cy: y(c.mood), c }));
  const lineD = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.cx},${p.cy}`).join(" ");
  const areaD = `${lineD} L${pts[pts.length - 1].cx},${PAD.t + ih} L${pts[0].cx},${PAD.t + ih} Z`;

  const dots = pts.map((p) => `
    <circle cx="${p.cx}" cy="${p.cy}" r="5.5"
      fill="${p.c.alertSent ? "#b0402a" : line}"
      stroke="#fff" stroke-width="2">
      <title>${p.c.date} — mood ${p.c.mood}/10, ${p.c.emotion.Type} (${p.c.emotion.Confidence.toFixed(0)}%)</title>
    </circle>`).join("");

  const xLabels = pts.map((p) => `
    <text x="${p.cx}" y="${H - 10}" text-anchor="middle" font-size="10" fill="#a99f88">${p.c.date.slice(5)}</text>`).join("");

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Mood score trend chart">
      <defs>
        <linearGradient id="pulseFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${line}" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="${line}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${grid}
      <path d="${areaD}" fill="url(#pulseFill)"/>
      <path d="${lineD}" fill="none" stroke="${line}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      ${dots}
      ${xLabels}
    </svg>`;
}

/* check-in history */
function renderFeed(checkins) {
  const feed = document.getElementById("checkinFeed");
  if (checkins.length === 0) { feed.innerHTML = ""; return; }

  feed.innerHTML = [...checkins].reverse().map((c) => `
    <li>
      <div class="date">${c.date}<br /><span style="font-weight:600">${c.staff || ""}</span></div>
      <div>
        <p>${c.notes || "<span class='muted'>No notes recorded.</span>"}</p>
        <div class="meta">
          <span class="mood-pill">Mood ${c.mood}/10</span>
          <span class="chip ${["SAD","FEAR","ANGRY","DISGUSTED"].includes(c.emotion.Type) ? "chip-neg" : "chip-pos"}">
            ${c.emotion.Type} ${c.emotion.Confidence.toFixed(0)}%
          </span>
          <span class="chip ${SENTIMENT_CHIP[c.sentiment] || "chip-neutral"}">${c.sentiment}</span>
          ${c.alertSent ? '<span class="chip chip-neg">⚠ SNS alert sent</span>' : ""}
        </div>
      </div>
    </li>`).join("");
}

/* on-demand bed check — a quick, staff-triggered camera glance, not
   continuous monitoring. Runs the frame through our OWN trained Rekognition
   Custom Labels model (occupied vs empty bed): occupied → "in bed", empty →
   logged as a bed exit and folded into the existing triage scoring (see
   urgencyFor() in api.js, which already reacts to bedExitsNight). */
let bedCameraStream = null;
const bedCheckBtn = document.getElementById("bedCheckBtn");
const bedCameraPanel = document.getElementById("bedCameraPanel");
const bedCameraVideo = document.getElementById("bedCameraVideo");
const bedCheckCaptureBtn = document.getElementById("bedCheckCaptureBtn");
const bedCheckCancelBtn = document.getElementById("bedCheckCancelBtn");
const bedCheckResult = document.getElementById("bedCheckResult");
const bedUploadBtn = document.getElementById("bedUploadBtn");
const bedUploadInput = document.getElementById("bedUploadInput");

bedCheckBtn.addEventListener("click", startBedCheckCamera);
bedCheckCancelBtn.addEventListener("click", stopBedCheckCamera);
bedCheckCaptureBtn.addEventListener("click", runBedCheck);

// upload path — same analysis/result pipeline as the camera, just fed a
// picked file instead of a captured frame. Handy for demos away from an
// actual bed (e.g. testing with a stock photo).
bedUploadBtn.addEventListener("click", () => bedUploadInput.click());
bedUploadInput.addEventListener("change", () => {
  if (bedUploadInput.files.length) runBedCheckFromFile(bedUploadInput.files[0]);
});

async function startBedCheckCamera() {
  try {
    // "ideal" (not a hard constraint) so this still works on laptops with
    // only a front camera, which would otherwise reject "environment"
    bedCameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } }, audio: false,
    });
  } catch (e) {
    bedCheckResult.innerHTML = `<p class="muted">Couldn't access the camera — check browser/site permissions.</p>`;
    bedCheckResult.classList.remove("hidden");
    return;
  }
  bedCameraVideo.srcObject = bedCameraStream;
  bedCameraPanel.classList.remove("hidden");
  bedCheckBtn.classList.add("hidden");
}

function stopBedCheckCamera() {
  if (bedCameraStream) {
    bedCameraStream.getTracks().forEach((t) => t.stop());
    bedCameraStream = null;
  }
  bedCameraVideo.srcObject = null;
  bedCameraPanel.classList.add("hidden");
  bedCheckBtn.classList.remove("hidden");
}

async function runBedCheck() {
  if (!bedCameraStream) return;
  bedCheckCaptureBtn.disabled = true;
  bedCheckCaptureBtn.textContent = "Checking…";

  const shot = document.createElement("canvas");
  shot.width = bedCameraVideo.videoWidth || 640;
  shot.height = bedCameraVideo.videoHeight || 480;
  shot.getContext("2d").drawImage(bedCameraVideo, 0, 0, shot.width, shot.height);
  const shotDataUrl = shot.toDataURL("image/jpeg", 0.9);
  const blob = await new Promise((resolve) => shot.toBlob(resolve, "image/jpeg", 0.9));
  const file = new File([blob], "bed-check.jpg", { type: "image/jpeg" });

  const res = await apiAnalyseBed(file, patientId); // our trained Custom Labels model
  stopBedCheckCamera();
  bedCheckCaptureBtn.disabled = false;
  bedCheckCaptureBtn.textContent = "Run check";

  // model missing or stopped — say so plainly instead of guessing
  if (!res.success) {
    bedCheckResult.innerHTML = `
      <div class="banner banner-alert" role="alert">
        <span class="icon">⚠</span>
        <span>${res.message || "Bed-occupancy model unavailable."}</span>
      </div>`;
    bedCheckResult.classList.remove("hidden");
    return;
  }

  await handleBedCheckResult(res.occupied, res.top, res.boundingBox, shotDataUrl);
}

async function runBedCheckFromFile(file) {
  stopBedCheckCamera(); // in case the camera panel happened to be open
  bedCheckResult.classList.add("hidden");
  bedUploadBtn.disabled = true;
  bedUploadBtn.textContent = "Checking…";

  const shotDataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsDataURL(file);
  });

  const res = await apiAnalyseBed(file, patientId); // our trained Custom Labels model
  bedUploadBtn.disabled = false;
  bedUploadBtn.textContent = "🖼️ Upload a photo instead";
  bedUploadInput.value = ""; // reset so choosing the same file again still fires "change"

  // model missing or stopped — say so plainly instead of guessing
  if (!res.success) {
    bedCheckResult.innerHTML = `
      <div class="banner banner-alert" role="alert">
        <span class="icon">⚠</span>
        <span>${res.message || "Bed-occupancy model unavailable."}</span>
      </div>`;
    bedCheckResult.classList.remove("hidden");
    return;
  }

  await handleBedCheckResult(res.occupied, res.top, res.boundingBox, shotDataUrl);
}

/* draws the captured frame with the model's detected bounding box overlaid
   — the box's Left/Top/Width/Height are 0–1 ratios Rekognition computed
   itself from the trained model, positioned here with plain percentage CSS */
function renderBedShot(dataUrl, box) {
  const boxHtml = box
    ? `<div class="bedbox" style="left:${box.left * 100}%; top:${box.top * 100}%; width:${box.width * 100}%; height:${box.height * 100}%"></div>`
    : "";
  return `<div class="bedshot-wrap"><img src="${dataUrl}" alt="Bed check capture" />${boxHtml}</div>`;
}

async function handleBedCheckResult(occupied, top, boundingBox, shotDataUrl) {
  const conf = top ? ` (${top.Name} ${top.Confidence}%)` : "";
  const shot = shotDataUrl ? renderBedShot(shotDataUrl, boundingBox) : "";
  if (occupied) {
    bedCheckResult.innerHTML = `
      ${shot}
      <div class="banner banner-ok">
        <span class="icon">✓</span>
        <span>Bed reads <strong>occupied</strong>${conf} — patient appears to be in bed.</span>
      </div>`;
    bedCheckResult.classList.remove("hidden");
    return;
  }

  // bed reads empty → log a bed exit and let the existing triage rules react
  const m = currentPatient.monitoring || {};
  const bedExitsNight = (m.bedExitsNight || 0) + 1;
  const highRisk = bedExitsNight >= 4 ? true : m.highRisk;
  const monitoring = { ...m, bedExitsNight, highRisk };

  const upd = await apiUpdatePatient(patientId, { monitoring });
  if (upd.success) currentPatient = upd.patient;

  bedCheckResult.innerHTML = `
    ${shot}
    <div class="banner banner-alert" role="alert">
      <span class="icon">⚠</span>
      <span>Bed reads <strong>empty</strong>${conf} — logged as a bed exit (${bedExitsNight} tonight).${highRisk ? " Flagged high-risk." : ""}</span>
    </div>`;
  bedCheckResult.classList.remove("hidden");

  refreshCareSignals();

  // repeated exits crossing the high-risk line → same SNS alert path a distress check-in uses
  if (bedExitsNight >= 4) {
    const alertRes = await apiSendDistressAlert(patientId, { Type: "WANDERING", Confidence: 100 });
    if (alertRes.success) {
      bedCheckResult.innerHTML += `
        <div class="banner banner-alert" role="alert" style="margin-top:8px">
          <span class="icon">⚠</span>
          <span><strong>Distress alert dispatched.</strong> ${alertRes.sns.Summary}</span>
        </div>`;
    }
  }
}

init();
