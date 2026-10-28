/*
   NoFaceNoCase (NFNC) — API layer
   Syed Ghazi (2504242E) · CAI2C09

   Whole fake larping backend. Made to look like thing is working*/

/* the real API Gateway URL goes here once there's a backend to hit */
const API_BASE_URL = "https://REPLACE_ME.execute-api.us-east-1.amazonaws.com/prod";

/* fake network delay so it feels like a real request */
const MOCK_LATENCY = 650;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Seed data — stands in for the RDS tables. Lives in localStorage so CRUD
   actually sticks across pages. Everyone here is made up. */
/* v2 — patients now carry a status + a monitoring snapshot (sleep, movement,
   day/night activity, bed-exits, high-risk). Bumping the key wipes any old
   cached seed so the new fields show up. */
const NFNC_DB_KEY = "nfnc_db_v2";

/* patient lifecycle status */
const PATIENT_STATUSES = ["Admitted", "Observation", "Discharged"];

const SEED_DB = {
  patients: [
    { patientId: "P-1001", name: "Tan Wei Ming", age: 34, ward: "Ward 3A", condition: "Generalised anxiety", clinician: "Dr. Aisha Rahman", admitted: "2026-05-12", status: "Admitted",
      monitoring: { sleepHours: 6.2, sleepQuality: "Fair", movement: "Moderate", dayActiveHrs: 8.5, nightActiveHrs: 1.1, bedExitsNight: 1, highRisk: false } },
    { patientId: "P-1002", name: "Nurul Izzah", age: 27, ward: "Ward 3A", condition: "Major depressive disorder", clinician: "Dr. Aisha Rahman", admitted: "2026-05-30", status: "Observation",
      monitoring: { sleepHours: 5.0, sleepQuality: "Poor", movement: "Low", dayActiveHrs: 6.0, nightActiveHrs: 1.6, bedExitsNight: 1, highRisk: false } },
    { patientId: "P-1003", name: "Marcus Lee", age: 45, ward: "Ward 2B", condition: "PTSD", clinician: "Dr. Kevin Ong", admitted: "2026-06-03", status: "Admitted",
      monitoring: { sleepHours: 4.3, sleepQuality: "Poor", movement: "Restless", dayActiveHrs: 7.5, nightActiveHrs: 2.4, bedExitsNight: 3, highRisk: false } },
    { patientId: "P-1004", name: "Priya Nair", age: 52, ward: "Ward 2B", condition: "Depression (recurrent)", clinician: "Dr. Kevin Ong", admitted: "2026-06-11", status: "Observation",
      monitoring: { sleepHours: 7.4, sleepQuality: "Good", movement: "Active", dayActiveHrs: 9.5, nightActiveHrs: 0.6, bedExitsNight: 0, highRisk: false } },
    { patientId: "P-1005", name: "Daniel Chua", age: 19, ward: "Ward 4C", condition: "Adjustment disorder", clinician: "Dr. Aisha Rahman", admitted: "2026-06-20", status: "Admitted",
      monitoring: { sleepHours: 6.8, sleepQuality: "Fair", movement: "Moderate", dayActiveHrs: 8.0, nightActiveHrs: 0.9, bedExitsNight: 1, highRisk: false } },
    { patientId: "P-1006", name: "Rosnah Bte Yusof", age: 78, ward: "Ward 4C", condition: "Dementia (fall risk)", clinician: "Dr. Kevin Ong", admitted: "2026-06-15", status: "Admitted",
      monitoring: { sleepHours: 3.8, sleepQuality: "Poor", movement: "Restless", dayActiveHrs: 5.5, nightActiveHrs: 3.9, bedExitsNight: 5, highRisk: true } }
  ],
  medications: [
    { medId: "M-01", patientId: "P-1001", name: "Zolpidem 10mg (sleep)", date: "2026-06-24", by: "Dr. Aisha Rahman" },
    { medId: "M-02", patientId: "P-1002", name: "Sertraline 50mg",       date: "2026-06-27", by: "Dr. Aisha Rahman" }
  ],
  checkins: [
    { checkinId: "C-9001", patientId: "P-1001", date: "2026-06-22", mood: 4, notes: "Patient reports poor sleep, worried about discharge planning.", emotion: { Type: "CALM", Confidence: 71.2 },  sentiment: "NEGATIVE", alertSent: false, staff: "SN Farah" },
    { checkinId: "C-9002", patientId: "P-1001", date: "2026-06-26", mood: 5, notes: "Slightly better after family visit. Engaged in group activity.", emotion: { Type: "HAPPY", Confidence: 63.8 }, sentiment: "MIXED",    alertSent: false, staff: "SN Farah" },
    { checkinId: "C-9003", patientId: "P-1001", date: "2026-07-01", mood: 6, notes: "Calm this morning, appetite improving.",                        emotion: { Type: "CALM", Confidence: 88.4 },  sentiment: "POSITIVE", alertSent: false, staff: "SN Lim" },
    { checkinId: "C-9004", patientId: "P-1002", date: "2026-06-24", mood: 3, notes: "Withdrawn during breakfast, minimal eye contact.",              emotion: { Type: "SAD", Confidence: 91.6 },   sentiment: "NEGATIVE", alertSent: true,  staff: "SN Lim" },
    { checkinId: "C-9005", patientId: "P-1002", date: "2026-06-29", mood: 4, notes: "Attended art therapy, briefly participated.",                   emotion: { Type: "SAD", Confidence: 67.0 },   sentiment: "MIXED",    alertSent: false, staff: "SN Farah" },
    { checkinId: "C-9006", patientId: "P-1002", date: "2026-07-03", mood: 5, notes: "Initiated conversation with roommate. Small improvement.",      emotion: { Type: "CALM", Confidence: 74.9 },  sentiment: "POSITIVE", alertSent: false, staff: "SN Lim" },
    { checkinId: "C-9007", patientId: "P-1003", date: "2026-06-25", mood: 6, notes: "Stable, discussed coping strategies during rounds.",            emotion: { Type: "CALM", Confidence: 82.3 },  sentiment: "POSITIVE", alertSent: false, staff: "SN Kumar" },
    { checkinId: "C-9008", patientId: "P-1003", date: "2026-07-02", mood: 4, notes: "Startled response overnight, reported nightmares.",             emotion: { Type: "FEAR", Confidence: 84.7 },  sentiment: "NEGATIVE", alertSent: true,  staff: "SN Kumar" },
    { checkinId: "C-9009", patientId: "P-1004", date: "2026-06-28", mood: 7, notes: "Positive session with clinician, looking forward to home leave.", emotion: { Type: "HAPPY", Confidence: 90.1 }, sentiment: "POSITIVE", alertSent: false, staff: "SN Farah" },
    { checkinId: "C-9010", patientId: "P-1005", date: "2026-07-04", mood: 5, notes: "Settling into ward routine, mild homesickness.",                emotion: { Type: "CALM", Confidence: 69.5 },  sentiment: "MIXED",    alertSent: false, staff: "SN Lim" },
    { checkinId: "C-9011", patientId: "P-1006", date: "2026-06-30", mood: 4, notes: "Disoriented in the evening, wandered toward the ward exit.",     emotion: { Type: "FEAR", Confidence: 81.0 },  sentiment: "NEGATIVE", alertSent: true,  staff: "SN Kumar" },
    { checkinId: "C-9012", patientId: "P-1006", date: "2026-07-04", mood: 3, notes: "Left bed 5 times overnight, calling out, not oriented to place.", emotion: { Type: "FEAR", Confidence: 86.5 },  sentiment: "NEGATIVE", alertSent: true,  staff: "SN Lim" }
  ]
};

function loadDB() {
  const raw = localStorage.getItem(NFNC_DB_KEY);
  if (raw) { try { return JSON.parse(raw); } catch (e) { /* fall through */ } }
  const fresh = JSON.parse(JSON.stringify(SEED_DB));
  localStorage.setItem(NFNC_DB_KEY, JSON.stringify(fresh));
  return fresh;
}

function saveDB(db) {
  localStorage.setItem(NFNC_DB_KEY, JSON.stringify(db));
}

/* 1. Auth — Cognito, but faked */
async function apiLogin(email, password) {
  /* the real one:
     const res = await fetch(`${API_BASE_URL}/auth/login`, {
       method: "POST",
       headers: { "Content-Type": "application/json" },
       body: JSON.stringify({ email, password })
     });
     return res.json();
  */
  await delay(MOCK_LATENCY);

  // fake user pool
  const USERS = {
    "nurse@nfnc.sg":     { role: "nurse",     name: "SN Farah Binte Osman" },
    "clinician@nfnc.sg": { role: "clinician", name: "Dr. Aisha Rahman" }
  };
  const user = USERS[email.toLowerCase().trim()];
  if (user && password === "Demo123!") {
    return {
      success: true,
      token: "mock-jwt-token." + btoa(email) + ".signature",  // pretend JWT
      user: { email, role: user.role, name: user.name }
    };
  }
  return { success: false, message: "Incorrect email or password." };
}

/* 2. Patient CRUD — normally API Gateway → Lambda → RDS */

/* grab everyone */
async function apiGetPatients() {
  /* the real one:
     const res = await fetch(`${API_BASE_URL}/patients`, {
       headers: { Authorization: sessionStorage.getItem("nfnc_token") }
     });
     return res.json();
  */
  await delay(MOCK_LATENCY);
  return { success: true, patients: loadDB().patients };
}

/* grab one */
async function apiGetPatient(patientId) {
  /* real: fetch(`${API_BASE_URL}/patients/${patientId}`) */
  await delay(MOCK_LATENCY / 2);
  const patient = loadDB().patients.find((p) => p.patientId === patientId);
  return patient ? { success: true, patient } : { success: false, message: "Patient not found." };
}

/* add one */
async function apiCreatePatient(patientData) {
  /* the real one:
     const res = await fetch(`${API_BASE_URL}/patients`, {
       method: "POST",
       headers: { "Content-Type": "application/json",
                  Authorization: sessionStorage.getItem("nfnc_token") },
       body: JSON.stringify(patientData)
     });
     return res.json();
  */
  await delay(MOCK_LATENCY);
  const db = loadDB();
  const nextNum = 1000 + db.patients.length + 1;
  // defaults so a fresh patient still fills out the mood/triage UI
  const patient = {
    patientId: "P-" + nextNum,
    status: "Admitted",
    monitoring: { sleepHours: 7.0, sleepQuality: "Fair", movement: "Moderate", dayActiveHrs: 8.0, nightActiveHrs: 1.0, bedExitsNight: 0, highRisk: false },
    ...patientData
  };
  db.patients.push(patient);
  saveDB(db);
  return { success: true, patient };
}

/* change one */
async function apiUpdatePatient(patientId, updates) {
  /* real: fetch(`${API_BASE_URL}/patients/${patientId}`, { method: "PUT", ... }) */
  await delay(MOCK_LATENCY);
  const db = loadDB();
  const idx = db.patients.findIndex((p) => p.patientId === patientId);
  if (idx === -1) return { success: false, message: "Patient not found." };
  db.patients[idx] = { ...db.patients[idx], ...updates };
  saveDB(db);
  return { success: true, patient: db.patients[idx] };
}

/* remove one */
async function apiDeletePatient(patientId) {
  /* real: fetch(`${API_BASE_URL}/patients/${patientId}`, { method: "DELETE", ... }) */
  await delay(MOCK_LATENCY);
  const db = loadDB();
  db.patients = db.patients.filter((p) => p.patientId !== patientId);
  db.checkins = db.checkins.filter((c) => c.patientId !== patientId);
  saveDB(db);
  return { success: true, deleted: patientId };
}

/* 3. Check-ins — read + insert */
async function apiGetCheckins(patientId) {
  /* real: fetch(`${API_BASE_URL}/patients/${patientId}/checkins`) */
  await delay(MOCK_LATENCY / 2);
  const rows = loadDB()
    .checkins.filter((c) => c.patientId === patientId)
    .sort((a, b) => a.date.localeCompare(b.date));
  return { success: true, checkins: rows };
}

/* a patient's meds — feeds the before/after mood thing */
async function apiGetMedications(patientId) {
  /* real: fetch(`${API_BASE_URL}/patients/${patientId}/medications`) */
  await delay(MOCK_LATENCY / 2);
  const rows = (loadDB().medications || [])
    .filter((m) => m.patientId === patientId)
    .sort((a, b) => a.date.localeCompare(b.date));
  return { success: true, medications: rows };
}

async function apiCreateCheckin(checkinData) {
  /* real: fetch(`${API_BASE_URL}/checkins`, { method: "POST", ... }) */
  await delay(MOCK_LATENCY);
  const db = loadDB();
  const checkin = { checkinId: "C-" + (9000 + db.checkins.length + 1), ...checkinData };
  db.checkins.push(checkin);
  saveDB(db);
  return { success: true, checkin };
}

/* 4. Rekognition — facial emotion. Faked, but the shapes below are exactly
   what DetectFaces spits out (that Emotions array). */
const MOCK_REKOGNITION_RESULTS = [
  { FaceDetails: [{ Emotions: [ { Type: "HAPPY", Confidence: 89.42 }, { Type: "CALM", Confidence: 7.11 },  { Type: "SURPRISED", Confidence: 1.9 } ] }] },
  { FaceDetails: [{ Emotions: [ { Type: "CALM", Confidence: 76.03 },  { Type: "HAPPY", Confidence: 14.55 }, { Type: "SAD", Confidence: 5.2 } ] }] },
  { FaceDetails: [{ Emotions: [ { Type: "SAD", Confidence: 87.66 },   { Type: "FEAR", Confidence: 6.02 },   { Type: "CALM", Confidence: 3.1 } ] }] },
  { FaceDetails: [{ Emotions: [ { Type: "FEAR", Confidence: 83.19 },  { Type: "SAD", Confidence: 9.44 },    { Type: "SURPRISED", Confidence: 4.0 } ] }] },
  { FaceDetails: [{ Emotions: [ { Type: "SURPRISED", Confidence: 64.8 }, { Type: "HAPPY", Confidence: 20.1 }, { Type: "CALM", Confidence: 9.7 } ] }] }
];

async function apiAnalyseImage(file) {
  /* the real flow:
     1. PUT the image to S3 via a pre-signed URL
     2. POST the S3 key to /rekognition/analyse
     3. Lambda runs DetectFaces and hands back the Emotions array

     const res = await fetch(`${API_BASE_URL}/rekognition/analyse`, {
       method: "POST",
       headers: { "Content-Type": "application/json",
                  Authorization: sessionStorage.getItem("nfnc_token") },
       body: JSON.stringify({ s3Key: uploadedKey })
     });
     return res.json();
  */
  await delay(MOCK_LATENCY * 2); // pretend the image takes a bit longer

  // same file → same result, so it stays consistent during a demo
  const pick = file && file.size ? file.size % MOCK_REKOGNITION_RESULTS.length : 0;
  const result = MOCK_REKOGNITION_RESULTS[pick];
  return { success: true, rekognition: result };
}

/* 5. Comprehend — sentiment on the notes. Just a keyword heuristic so it
   reacts to whatever you type; the response shape matches Comprehend. */
async function apiAnalyseSentiment(text) {
  /* real: fetch(`${API_BASE_URL}/comprehend/sentiment`, { method:"POST", body: JSON.stringify({ text }) }) */
  await delay(MOCK_LATENCY);
  const t = (text || "").toLowerCase();
  const negWords = ["withdrawn", "worse", "poor", "crying", "distress", "refus", "nightmare", "anxious", "agitated", "hopeless", "no appetite"];
  const posWords = ["improv", "better", "calm", "engaged", "smil", "positive", "participat", "good", "stable", "looking forward"];
  const neg = negWords.some((w) => t.includes(w));
  const pos = posWords.some((w) => t.includes(w));

  let Sentiment = "NEUTRAL";
  let SentimentScore = { Positive: 0.08, Negative: 0.07, Neutral: 0.82, Mixed: 0.03 };
  if (pos && neg) { Sentiment = "MIXED";    SentimentScore = { Positive: 0.31, Negative: 0.29, Neutral: 0.12, Mixed: 0.28 }; }
  else if (neg)   { Sentiment = "NEGATIVE"; SentimentScore = { Positive: 0.04, Negative: 0.86, Neutral: 0.08, Mixed: 0.02 }; }
  else if (pos)   { Sentiment = "POSITIVE"; SentimentScore = { Positive: 0.88, Negative: 0.03, Neutral: 0.07, Mixed: 0.02 }; }

  return { success: true, comprehend: { Sentiment, SentimentScore } };
}

/* 6. SNS — distress alerts. If a negative emotion clears the threshold, this
   is what would ping the assigned clinician. */
const ALERT_THRESHOLD = 80; // % confidence
const NEGATIVE_EMOTIONS = ["SAD", "FEAR", "ANGRY", "DISGUSTED"];

async function apiSendDistressAlert(patientId, emotion) {
  /* real: fetch(`${API_BASE_URL}/alerts`, { method: "POST", body: JSON.stringify({ patientId, emotion }) })
     → Lambda → sns.publish({ TopicArn: DISTRESS_TOPIC_ARN, Message: ... })   */
  await delay(MOCK_LATENCY);
  return {
    success: true,
    sns: {
      MessageId: "mock-" + Math.random().toString(36).slice(2, 10),
      Topic: "arn:aws:sns:us-east-1:000000000000:nfnc-distress-alerts",
      Summary: `Alert sent to assigned clinician: ${emotion.Type} detected at ${emotion.Confidence.toFixed(1)}% confidence for patient ${patientId}.`
    }
  };
}

function isDistressEmotion(emotion) {
  return NEGATIVE_EMOTIONS.includes(emotion.Type) && emotion.Confidence >= ALERT_THRESHOLD;
}

/* 7. Mood state — the thing the whole UI colours itself around. Boils a
   patient's check-ins down to one current-wellbeing state. Latest check-in
   drives it; distress always wins so it never gets buried. */
const NEG_EMOTIONS_UI = ["SAD", "FEAR", "ANGRY", "DISGUSTED"];

/* key → label + colours (hex matches the CSS mood-* classes so the SVG chart
   can match the page) */
const MOOD_STATES = {
  distress: { key: "distress", label: "Distress",  hex: "#b0402a", soft: "#f4dcd2", deep: "#7c2a19" },
  low:      { key: "low",      label: "Low mood",  hex: "#b07d1c", soft: "#f4e7c8", deep: "#6d4c12" },
  steady:   { key: "steady",   label: "Steady",    hex: "#5f8f6f", soft: "#e0ecdf", deep: "#3c5c46" },
  thriving: { key: "thriving", label: "Thriving",  hex: "#2f7d5c", soft: "#d9ecdf", deep: "#215a41" },
  none:     { key: "none",     label: "No check-ins", hex: "#8a8474", soft: "#ece5d4", deep: "#5c5648" }
};

/* the state for a set of check-ins, plus the latest score */
function moodStateFor(checkins) {
  if (!checkins || checkins.length === 0) {
    return { ...MOOD_STATES.none, score: null, latest: null };
  }
  const sorted = [...checkins].sort((a, b) => a.date.localeCompare(b.date));
  const latest = sorted[sorted.length - 1];
  const negFace = NEG_EMOTIONS_UI.includes(latest.emotion.Type);

  const clearlyPositive = latest.emotion.Type === "HAPPY" && latest.sentiment === "POSITIVE";

  let key;
  if (latest.alertSent || latest.mood <= 3 || (negFace && latest.emotion.Confidence >= ALERT_THRESHOLD)) {
    key = "distress";
  } else if (latest.mood <= 5 || latest.sentiment === "NEGATIVE") {
    key = "low";
  } else if (latest.mood >= 8 || (latest.mood >= 7 && clearlyPositive)) {
    key = "thriving";
  } else {
    key = "steady";
  }
  return { ...MOOD_STATES[key], score: latest.mood, latest };
}

/* ward roll-up: how many patients sit in each state + the worst one present.
   drives the ward mood bar. order = urgency. */
const MOOD_ORDER = ["distress", "low", "steady", "thriving", "none"];
function wardMoodSummary(states) {
  const counts = { distress: 0, low: 0, steady: 0, thriving: 0, none: 0 };
  states.forEach((s) => { counts[s.key] = (counts[s.key] || 0) + 1; });
  const dominant = MOOD_ORDER.find((k) => counts[k] > 0) || "none";
  return { counts, dominant, total: states.length };
}

/* 8. Care signals — who needs help and how badly, where the mood's heading,
   and whether a med's doing anything. All rules-based, nothing fancy. */

/* 0 = routine … 3 = critical. colours match the CSS urgency-* classes. */
const URGENCY_LEVELS = [
  { level: 0, key: "routine",  label: "Routine",  hex: "#5f8f6f", soft: "#e0ecdf", deep: "#3c5c46" },
  { level: 1, key: "monitor",  label: "Monitor",  hex: "#b07d1c", soft: "#f4e7c8", deep: "#6d4c12" },
  { level: 2, key: "priority", label: "Priority", hex: "#c8792b", soft: "#f6e3cc", deep: "#7a4712" },
  { level: 3, key: "critical", label: "Critical", hex: "#b0402a", soft: "#f4dcd2", deep: "#7c2a19" }
];

/* mixes current mood + recent alerts + the monitoring snapshot (restless
   nights, bed exits, sleep, high-risk) into a triage level, and keeps the
   reasons around so staff can see why someone got flagged. */
function urgencyFor(patient, checkins) {
  const s = moodStateFor(checkins);
  const m = (patient && patient.monitoring) || {};
  let score = 0;
  const reasons = [];

  if (s.key === "distress") { score += 3; reasons.push("Current wellbeing reads distress"); }
  else if (s.key === "low") { score += 1; reasons.push("Mood is currently low"); }

  const recentAlert = [...checkins].reverse().find((c) => c.alertSent);
  if (recentAlert) { score += 1; reasons.push(`Distress alert on ${recentAlert.date}`); }

  const exits = m.bedExitsNight || 0;
  if (exits >= 4) { score += 3; reasons.push(`${exits} bed exits overnight`); }
  else if (exits >= 2) { score += 1; reasons.push(`${exits} bed exits overnight`); }

  if ((m.nightActiveHrs || 0) >= 2.5) { score += 1; reasons.push(`High night-time activity (${m.nightActiveHrs}h)`); }
  if ((m.sleepHours != null) && m.sleepHours < 4.5) { score += 1; reasons.push(`Sleep under 4.5h last night`); }
  if (m.highRisk) { score += 1; reasons.push("Flagged high-risk (fall / wandering)"); }

  const level = score >= 5 ? 3 : score >= 3 ? 2 : score >= 1 ? 1 : 0;
  return { ...URGENCY_LEVELS[level], score, reasons, needsAssist: level >= 2 };
}

/* least-squares line through the last few check-ins → a rough guess at the
   next mood and which way it's trending. nothing clever. */
function predictNextMood(checkins) {
  if (!checkins || checkins.length < 2) return null;
  const sorted = [...checkins].sort((a, b) => a.date.localeCompare(b.date));
  const recent = sorted.slice(-5);
  const n = recent.length;
  const xs = recent.map((_, i) => i);
  const ys = recent.map((c) => c.mood);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den === 0 ? 0 : num / den;
  const intercept = my - slope * mx;
  let value = intercept + slope * n;              // project one step ahead
  value = Math.max(1, Math.min(10, value));
  const trend = slope > 0.25 ? "improving" : slope < -0.25 ? "declining" : "stable";
  return { value: Math.round(value * 10) / 10, slope, trend, basis: n };
}

/* average mood before vs after each med's start date */
function medsResponse(checkins, meds) {
  const avg = (arr) => (arr.length ? arr.reduce((s, c) => s + c.mood, 0) / arr.length : null);
  return (meds || []).map((med) => {
    const before = checkins.filter((c) => c.date < med.date);
    const after  = checkins.filter((c) => c.date >= med.date);
    const b = avg(before), a = avg(after);
    return {
      med,
      before: b, after: a,
      delta: (b != null && a != null) ? Math.round((a - b) * 10) / 10 : null,
      nBefore: before.length, nAfter: after.length
    };
  });
}

/* Session helpers (fake Cognito session) */
function getSessionUser() {
  const raw = sessionStorage.getItem("nfnc_user");
  return raw ? JSON.parse(raw) : null;
}

function requireLogin() {
  const user = getSessionUser();
  if (!user) { window.location.href = "index.html"; }
  return user;
}

function logout() {
  sessionStorage.removeItem("nfnc_user");
  sessionStorage.removeItem("nfnc_token");
  window.location.href = "index.html";
}
