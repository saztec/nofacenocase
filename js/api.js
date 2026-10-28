/*
   NoFaceNoCase — API layer, the real one.
   Syed Ghazi (2504242E) · CAI2C09

   Same function names as the fake version, so none of the page code had to
   change. Login goes straight to Cognito, everything else goes through API
   Gateway with the resulting token attached. IDs live in config.js.

   To switch over: rename this file to api.js (keep a backup of the old one)
   and make sure config.js is loaded before it on every page.
*/

const API_BASE_URL = NFNC_CONFIG.API_BASE_URL;

/* the mood/urgency maths still runs in the browser, so keep this in sync with
   the Lambda's ALERT_THRESHOLD env var */
const ALERT_THRESHOLD = 80;
const NEGATIVE_EMOTIONS = ["SAD", "FEAR", "ANGRY", "DISGUSTED"];

/* every call goes through here so the token handling lives in one spot */
async function apiFetch(path, options = {}) {
  const token = sessionStorage.getItem("nfnc_token");
  const res = await fetch(API_BASE_URL + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(options.headers || {}),
    },
  });

  // token expired or missing — bounce them back to the login page
  if (res.status === 401) {
    sessionStorage.removeItem("nfnc_user");
    sessionStorage.removeItem("nfnc_token");
    window.location.href = "index.html";
    return { success: false, message: "Session expired." };
  }

  try {
    return await res.json();
  } catch (e) {
    return { success: false, message: "Bad response from the server (" + res.status + ")." };
  }
}

/* 1. Auth — talks to Cognito directly, no SDK needed */

/* one place both InitiateAuth and RespondToAuthChallenge go through — same
   endpoint, just a different X-Amz-Target and body shape */
async function cognitoCall(target, body) {
  const endpoint = "https://cognito-idp." + NFNC_CONFIG.REGION + ".amazonaws.com/";
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService." + target,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

/* turns a Cognito AuthenticationResult into the {success, token, user} shape
   the rest of the app expects */
function loginResultFrom(authResult, fallbackEmail) {
  const idToken = authResult.IdToken;
  const claims = decodeJwt(idToken);
  const groups = claims["cognito:groups"] || [];
  return {
    success: true,
    token: idToken,
    user: {
      email: claims.email || fallbackEmail,
      name: claims.name || claims.email || fallbackEmail,
      role: groups.includes("clinician") ? "clinician" : "nurse",
    },
  };
}

async function apiLogin(email, password) {
  let data;
  try {
    data = await cognitoCall("InitiateAuth", {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: NFNC_CONFIG.APP_CLIENT_ID,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    });
  } catch (e) {
    return { success: false, message: "Couldn't reach the sign-in service." };
  }

  if (data.AuthenticationResult) {
    return loginResultFrom(data.AuthenticationResult, email);
  }

  // Cognito hands back this challenge the first time a freshly-created user
  // signs in with the password they were given at creation. Rather than
  // making the person do anything special, just confirm that same password
  // as their permanent one — this needs no admin permissions at all, it's
  // the account holder finishing their own setup.
  if (data.ChallengeName === "NEW_PASSWORD_REQUIRED") {
    let challengeData;
    try {
      challengeData = await cognitoCall("RespondToAuthChallenge", {
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        ClientId: NFNC_CONFIG.APP_CLIENT_ID,
        Session: data.Session,
        ChallengeResponses: { USERNAME: email, NEW_PASSWORD: password },
      });
    } catch (e) {
      return { success: false, message: "Couldn't reach the sign-in service." };
    }

    if (challengeData.AuthenticationResult) {
      return loginResultFrom(challengeData.AuthenticationResult, email);
    }
    return {
      success: false,
      message: challengeData.message || "Couldn't finish setting up this account. Try again.",
    };
  }

  return { success: false, message: "Incorrect email or password." };
}

/* pull the payload out of a JWT — no verification here, the API does that */
function decodeJwt(token) {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(payload))));
  } catch (e) {
    return {};
  }
}

/* 2. Patient CRUD */
async function apiGetPatients() {
  return apiFetch("/patients");
}

async function apiGetPatient(patientId) {
  return apiFetch("/patients/" + encodeURIComponent(patientId));
}

async function apiCreatePatient(patientData) {
  return apiFetch("/patients", { method: "POST", body: JSON.stringify(patientData) });
}

async function apiUpdatePatient(patientId, updates) {
  return apiFetch("/patients/" + encodeURIComponent(patientId), {
    method: "PUT", body: JSON.stringify(updates),
  });
}

async function apiDeletePatient(patientId) {
  return apiFetch("/patients/" + encodeURIComponent(patientId), { method: "DELETE" });
}

/* 3. Check-ins and meds */
async function apiGetCheckins(patientId) {
  return apiFetch("/patients/" + encodeURIComponent(patientId) + "/checkins");
}

async function apiGetMedications(patientId) {
  return apiFetch("/patients/" + encodeURIComponent(patientId) + "/medications");
}

async function apiCreateCheckin(checkinData) {
  return apiFetch("/checkins", { method: "POST", body: JSON.stringify(checkinData) });
}

/* 4. Rekognition — shrink the photo first so we don't blow the payload limit */
async function apiAnalyseImage(file, patientId) {
  const imageBase64 = await shrinkImage(file);
  return apiFetch("/analyse/image", {
    method: "POST",
    body: JSON.stringify({ imageBase64, patientId: patientId || "" }),
  });
}

/* API Gateway caps a request at 10MB, so resize to max 1200px and re-encode.
   Also just faster to upload. */
function shrinkImage(file, maxSide = 1200, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Couldn't decode that image."));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxSide || height > maxSide) {
          const scale = maxSide / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* 5. Custom Labels — our own trained bed-occupancy model. Shrinks the photo
   first (same 10MB reason as the emotion path), then asks the custom model
   whether the bed is occupied or empty. */
async function apiAnalyseBed(file, patientId) {
  const imageBase64 = await shrinkImage(file);
  return apiFetch("/analyse/bed", {
    method: "POST",
    body: JSON.stringify({ imageBase64, patientId: patientId || "" }),
  });
}

/* 6. Comprehend */
async function apiAnalyseSentiment(text) {
  return apiFetch("/analyse/sentiment", { method: "POST", body: JSON.stringify({ text }) });
}

/* 6. SNS distress alert */
async function apiSendDistressAlert(patientId, emotion) {
  return apiFetch("/alerts", { method: "POST", body: JSON.stringify({ patientId, emotion }) });
}

function isDistressEmotion(emotion) {
  return NEGATIVE_EMOTIONS.includes(emotion.Type) && emotion.Confidence >= ALERT_THRESHOLD;
}

/* one-off: fills the tables with the demo ward. run it from the browser
   console after signing in, then forget it exists. */
async function apiSeed() {
  return apiFetch("/admin/seed", { method: "POST" });
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
  let value = intercept + slope * n;
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

/* Session helpers */
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
