/* NoFaceNoCase — check-in page. how it goes:
   1. Staff set a mood score + notes, maybe drop in a photo.
   2. Photo → apiAnalyseImage()      (fake Rekognition)
   3. Notes → apiAnalyseSentiment()  (fake Comprehend)
   4. Negative emotion ≥ 80%? → apiSendDistressAlert()  (fake SNS)
   5. Save  → apiCreateCheckin()                                     */

const user = requireLogin();
document.getElementById("userName").textContent = user.name;
document.getElementById("userRole").textContent = user.role;

const params = new URLSearchParams(window.location.search);
const patientId = params.get("id");
if (!patientId) window.location.href = "dashboard.html";
document.getElementById("backLink").href = "patient.html?id=" + patientId;

let currentPatient = null;
let rekognitionEmotions = null; // Emotions array from the fake analysis
let dominantEmotion = null;

async function loadPatient() {
  const res = await apiGetPatient(patientId);
  if (!res.success) { window.location.href = "dashboard.html"; return; }
  currentPatient = res.patient;
  document.getElementById("patientId").textContent = res.patient.patientId + " · " + res.patient.ward;
  document.getElementById("patientMeta").textContent =
    "Recording a check-in for " + res.patient.name + " (assigned to " + res.patient.clinician + ").";
}
loadPatient();

/* mood slider */
const moodInput = document.getElementById("mood");
const moodReadout = document.getElementById("moodReadout");
moodInput.addEventListener("input", () => (moodReadout.textContent = moodInput.value));

/* photo flow */
const dropzone = document.getElementById("dropzone");
const photoInput = document.getElementById("photoInput");

dropzone.addEventListener("click", () => photoInput.click());
dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") photoInput.click(); });
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files.length) handlePhoto(e.dataTransfer.files[0]);
});
photoInput.addEventListener("change", () => {
  if (photoInput.files.length) handlePhoto(photoInput.files[0]);
});

/* live camera flow — captures one still frame for Rekognition (same path as
   a file upload), then samples ~3s of the live video to estimate movement.
   Frame-difference motion detection in the browser, not a real motion
   sensor — it's a stand-in that's honest about what it actually measures. */
let cameraStream = null;
const cameraBtn = document.getElementById("cameraBtn");
const cameraPanel = document.getElementById("cameraPanel");
const cameraVideo = document.getElementById("cameraVideo");
const captureBtn = document.getElementById("captureBtn");
const cancelCameraBtn = document.getElementById("cancelCameraBtn");
const movementPanel = document.getElementById("movementPanel");
const movementResult = document.getElementById("movementResult");

cameraBtn.addEventListener("click", startCamera);
cancelCameraBtn.addEventListener("click", stopCamera);
captureBtn.addEventListener("click", captureFromCamera);

async function startCamera() {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
  } catch (e) {
    showToast("Couldn't access the camera — check browser/site permissions.");
    return;
  }
  cameraVideo.srcObject = cameraStream;
  cameraPanel.classList.remove("hidden");
  cameraBtn.classList.add("hidden");
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
  cameraVideo.srcObject = null;
  cameraPanel.classList.add("hidden");
  cameraBtn.classList.remove("hidden");
}

async function captureFromCamera() {
  if (!cameraStream) return;
  captureBtn.disabled = true;
  cancelCameraBtn.disabled = true;

  // still frame → same handlePhoto() path a file upload takes
  const shot = document.createElement("canvas");
  shot.width = cameraVideo.videoWidth || 640;
  shot.height = cameraVideo.videoHeight || 480;
  shot.getContext("2d").drawImage(cameraVideo, 0, 0, shot.width, shot.height);
  const blob = await new Promise((resolve) => shot.toBlob(resolve, "image/jpeg", 0.9));
  handlePhoto(new File([blob], "camera-capture.jpg", { type: "image/jpeg" }));

  // keep the feed alive a few seconds longer to sample motion
  captureBtn.textContent = "Sampling movement…";
  const level = await measureMovement(cameraVideo);
  stopCamera();
  captureBtn.disabled = false;
  cancelCameraBtn.disabled = false;
  captureBtn.textContent = "Capture photo";

  renderMovement(level);
  await saveMovement(level);
}

function sampleFrame(video, canvas) {
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

function frameDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  return sum / (a.length / 4);
}

async function measureMovement(video) {
  const w = 64, h = 48;
  const mc = document.createElement("canvas");
  mc.width = w; mc.height = h;

  const durationMs = 3000, intervalMs = 200;
  const samples = [];
  let prev = sampleFrame(video, mc);
  const start = Date.now();
  while (Date.now() - start < durationMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const cur = sampleFrame(video, mc);
    samples.push(frameDiff(prev, cur));
    prev = cur;
  }

  // thresholds are illustrative, not calibrated against real accelerometer data
  const avg = samples.reduce((a, b) => a + b, 0) / (samples.length || 1);
  if (avg < 2) return "Low";
  if (avg < 6) return "Moderate";
  if (avg < 14) return "Active";
  return "Restless";
}

function renderMovement(level) {
  movementResult.innerHTML =
    `<strong>${level}</strong> <span class="muted" style="font-size:0.8rem">— from a 3-second live camera sample, saved to this patient's monitoring record.</span>`;
  movementPanel.classList.remove("hidden");
}

async function saveMovement(level) {
  if (!currentPatient) return;
  const monitoring = { ...(currentPatient.monitoring || {}), movement: level };
  const res = await apiUpdatePatient(patientId, { monitoring });
  if (res.success) currentPatient = res.patient;
}

async function handlePhoto(file) {
  if (!file.type.startsWith("image/")) {
    showToast("Choose an image file (JPG or PNG).");
    return;
  }

  // show the photo in the dropzone
  const reader = new FileReader();
  reader.onload = (e) => {
    dropzone.innerHTML = `<img class="preview" src="${e.target.result}" alt="Patient photo preview" />
      <span style="font-size:0.8rem">Analysing photo… <span class="spin dark"></span></span>`;
  };
  reader.readAsDataURL(file);

  // sends the photo to Rekognition for real facial emotion analysis
  const res = await apiAnalyseImage(file, patientId);
  if (!res.success || !res.rekognition.FaceDetails.length) {
    showToast(res.message || "No face detected — try another photo.");
    dropzone.querySelector("span").innerHTML = "Click to try a different photo.";
    return;
  }
  rekognitionEmotions = res.rekognition.FaceDetails[0].Emotions;
  dominantEmotion = rekognitionEmotions[0];

  dropzone.querySelector("span").innerHTML = "Analysis complete. Click to replace the photo.";
  renderEmotionBars(rekognitionEmotions);
  await maybeSendAlert();
}

function renderEmotionBars(emotions) {
  const panel = document.getElementById("analysisPanel");
  const bars = document.getElementById("emotionBars");
  const NEG = ["SAD", "FEAR", "ANGRY", "DISGUSTED"];
  bars.innerHTML = emotions.map((e) => `
    <div class="emo-bar">
      <span class="name">${e.Type}</span>
      <div class="emo-track"><div class="emo-fill ${NEG.includes(e.Type) ? "negative" : ""}" style="width:0%"></div></div>
      <span class="pct">${e.Confidence.toFixed(1)}%</span>
    </div>`).join("");
  panel.classList.remove("hidden");
  // Animate the fills after paint
  requestAnimationFrame(() => {
    panel.querySelectorAll(".emo-fill").forEach((el, i) => {
      el.style.width = emotions[i].Confidence + "%";
    });
  });
}

/* SNS distress alert */
async function maybeSendAlert() {
  const panel = document.getElementById("alertPanel");
  if (dominantEmotion && isDistressEmotion(dominantEmotion)) {
    panel.innerHTML = `
      <div class="banner banner-alert" role="alert">
        <span class="icon">⚠</span>
        <span>Dominant emotion <strong>${dominantEmotion.Type}</strong> at
        ${dominantEmotion.Confidence.toFixed(1)}% exceeds the ${ALERT_THRESHOLD}% distress threshold.
        Sending alert to the assigned clinician… <span class="spin dark"></span></span>
      </div>`;
    const res = await apiSendDistressAlert(patientId, dominantEmotion); // fake SNS publish
    panel.innerHTML = `
      <div class="banner banner-alert" role="alert">
        <span class="icon">⚠</span>
        <span><strong>Distress alert dispatched.</strong><br />${res.sns.Summary}<br />
        <span style="font-size:0.76rem">MessageId: ${res.sns.MessageId}</span></span>
      </div>`;
  } else if (dominantEmotion) {
    panel.innerHTML = `
      <div class="banner banner-ok">
        <span class="icon">✓</span>
        <span>Dominant emotion is ${dominantEmotion.Type} — below the distress alert threshold. No SNS alert required.</span>
      </div>`;
  }
}

/* submit */
const form = document.getElementById("checkinForm");
const toast = document.getElementById("toast");

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2600);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitBtn = document.getElementById("submitBtn");
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="spin"></span> Saving…';

  const notes = document.getElementById("notes").value.trim();

  // sentiment via fake Comprehend, only if they actually wrote notes
  let sentiment = "NEUTRAL";
  if (notes) {
    const sRes = await apiAnalyseSentiment(notes);
    sentiment = sRes.comprehend.Sentiment;
    const sp = document.getElementById("sentimentPanel");
    const chipClass = { POSITIVE: "chip-pos", NEGATIVE: "chip-neg", MIXED: "chip-mixed", NEUTRAL: "chip-neutral" }[sentiment];
    document.getElementById("sentimentResult").innerHTML =
      `<span class="chip ${chipClass}">${sentiment}</span>
       <span class="muted" style="font-size:0.8rem; margin-left:8px">
         Scores — P:${sRes.comprehend.SentimentScore.Positive.toFixed(2)}
         N:${sRes.comprehend.SentimentScore.Negative.toFixed(2)}
         Nu:${sRes.comprehend.SentimentScore.Neutral.toFixed(2)}
         M:${sRes.comprehend.SentimentScore.Mixed.toFixed(2)}</span>`;
    sp.classList.remove("hidden");
  }

  // save the check-in
  const checkin = {
    patientId,
    date: new Date().toISOString().slice(0, 10),
    mood: parseInt(moodInput.value, 10),
    notes,
    emotion: dominantEmotion || { Type: "UNKNOWN", Confidence: 0 },
    sentiment,
    alertSent: !!(dominantEmotion && isDistressEmotion(dominantEmotion)),
    staff: user.name
  };
  await apiCreateCheckin(checkin);

  showToast("Check-in saved for " + (currentPatient ? currentPatient.name : patientId));
  setTimeout(() => (window.location.href = "patient.html?id=" + patientId), 1200);
});
