// === DOM refs ===
const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const ctx = overlay.getContext("2d");
const statusChip = document.getElementById("status");
const gestureEl = document.getElementById("gesture");
const fpsEl = document.getElementById("fps");
const minDet = document.getElementById("minDet");
const minDetVal = document.getElementById("minDetVal");
const maxHands = document.getElementById("maxHands");
const camSelect = document.getElementById("cameraSelect");
const screenshotBtn = document.getElementById("screenshotBtn");

// === Utils ===
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const now = () => performance.now();

// Landmarks indices from MediaPipe Hands
const IDX = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
};

// Finger “up” heuristic (image space; y increases downward)
function fingersUp(landmarks, isRightHand) {
  const f = { thumb:false, index:false, middle:false, ring:false, pinky:false };

  // Non-thumb: tip above PIP (smaller y)
  f.index  = landmarks[IDX.INDEX_TIP].y  < landmarks[IDX.INDEX_PIP].y;
  f.middle = landmarks[IDX.MIDDLE_TIP].y < landmarks[IDX.MIDDLE_PIP].y;
  f.ring   = landmarks[IDX.RING_TIP].y   < landmarks[IDX.RING_PIP].y;
  f.pinky  = landmarks[IDX.PINKY_TIP].y  < landmarks[IDX.PINKY_PIP].y;

  // Thumb: compare x against MCP depending on handedness
  if (isRightHand) {
    f.thumb = landmarks[IDX.THUMB_TIP].x < landmarks[IDX.THUMB_IP].x;
  } else {
    f.thumb = landmarks[IDX.THUMB_TIP].x > landmarks[IDX.THUMB_IP].x;
  }
  return f;
}

// Simple rules to map finger states to a label
function classifyGesture(landmarks, handedness) {
  const isRight = handedness.toLowerCase().includes("right");
  const f = fingersUp(landmarks, isRight);

  const upCount = Object.values(f).filter(Boolean).length;

  // Distances helper (normalized)
  const dist = (a, b) => {
    const dx = landmarks[a].x - landmarks[b].x;
    const dy = landmarks[a].y - landmarks[b].y;
    return Math.hypot(dx, dy);
  };

  // OK sign: index tip near thumb tip, other fingers relaxed/down
  const okClose = dist(IDX.INDEX_TIP, IDX.THUMB_TIP) < 0.08;

  if (okClose && !f.middle && !f.ring && !f.pinky) return "OK 👌";
  if (upCount === 5) return "Open Palm ✋";
  if (upCount === 0) return "Fist ✊";
  if (f.index && f.middle && !f.ring && !f.pinky && !f.thumb) return "Peace ✌️";
  if (f.thumb && !f.index && !f.middle && !f.ring && !f.pinky) return "Thumbs Up 👍";

  return "Unknown";
}

// Draw helpers
function drawLandmarks(landmarks) {
  const w = overlay.width, h = overlay.height;

  // Bones (connections)
  const connections = [
    [0,1],[1,2],[2,3],[3,4],
    [0,5],[5,6],[6,7],[7,8],
    [0,9],[9,10],[10,11],[11,12],
    [0,13],[13,14],[14,15],[15,16],
    [0,17],[17,18],[18,19],[19,20]
  ];
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.9;
  connections.forEach(([a,b])=>{
    ctx.beginPath();
    ctx.moveTo(landmarks[a].x * w, landmarks[a].y * h);
    ctx.lineTo(landmarks[b].x * w, landmarks[b].y * h);
    ctx.stroke();
  });

  // Dots
  landmarks.forEach((p, i)=>{
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, 4, 0, Math.PI*2);
    ctx.fill();
  });
}

// === Camera selection ===
async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const videos = devices.filter(d => d.kind === "videoinput");
  camSelect.innerHTML = "";
  videos.forEach((d, i) => {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Camera ${i+1}`;
    camSelect.appendChild(opt);
  });
  return videos.map(v => v.deviceId);
}

let camera = null; // MediaPipe camera object
let hands = null;

async function startCamera(deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert("Camera not supported in this browser.");
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width: { ideal: 960 }, height: { ideal: 540 }, facingMode: "user"
    },
    audio: false
  });
  video.srcObject = stream;
  await video.play();

  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
}

// === FPS calc ===
let lastTime = now(), frameCount = 0, fps = 0;
function updateFps() {
  frameCount++;
  const t = now();
  if (t - lastTime >= 1000) {
    fps = frameCount;
    frameCount = 0;
    lastTime = t;
    fpsEl.textContent = `FPS: ${fps}`;
  }
}

// === MediaPipe Hands setup ===
function setupHands() {
  hands = new Hands({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });

  hands.setOptions({
    selfieMode: true,
    maxNumHands: parseInt(maxHands.value, 10),
    modelComplexity: 1,
    minDetectionConfidence: parseFloat(minDet.value),
    minTrackingConfidence: 0.5,
  });

  hands.onResults(onResults);
}

async function onResults(results) {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  updateFps();

  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    gestureEl.textContent = "—";
    statusChip.textContent = "Show your hand to the camera";
    return;
  }

  statusChip.textContent = `${results.multiHandLandmarks.length} hand(s)`;

  results.multiHandLandmarks.forEach((lm, i) => {
    ctx.save();
    ctx.strokeStyle = "#7ea0ff";
    ctx.fillStyle = "#bcd1ff";
    drawLandmarks(lm);
    ctx.restore();

    const handed = results.multiHandedness?.[i]?.label || "Right";
    const g = classifyGesture(lm, handed);
    gestureEl.textContent = g;
  });
}

// === Drive the pipeline using camera frames ===
async function startPipeline() {
  if (!hands) setupHands();

  if (!camera) {
    camera = new Camera(video, {
      onFrame: async () => {
        await hands.send({ image: video });
      },
      width: 960, height: 540,
    });
  }
  await camera.start();
}

// === UI wiring ===
minDet.addEventListener("input", () => {
  minDetVal.textContent = parseFloat(minDet.value).toFixed(2);
  hands?.setOptions({ minDetectionConfidence: parseFloat(minDet.value) });
});
maxHands.addEventListener("change", () => {
  hands?.setOptions({ maxNumHands: parseInt(maxHands.value, 10) });
});
camSelect.addEventListener("change", async (e) => {
  // Switch camera
  const id = e.target.value;
  await startCamera(id);
});

screenshotBtn.addEventListener("click", () => {
  // Compose video + overlay to a single image
  const w = overlay.width, h = overlay.height;
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const octx = out.getContext("2d");
  octx.save();
  // Draw mirrored video
  octx.translate(w, 0);
  octx.scale(-1, 1);
  octx.drawImage(video, 0, 0, w, h);
  octx.restore();
  // Draw overlay landmarks (already mirrored)
  octx.drawImage(overlay, 0, 0, w, h);
  const url = out.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url; a.download = "hand-gesture.png"; a.click();
});

// === Boot ===
(async function init(){
  try{
    await listCameras();
    await startCamera(camSelect.value || undefined);
    setupHands();
    await startPipeline();
    statusChip.textContent = "Model ready ✅";
  }catch(err){
    console.error(err);
    statusChip.textContent = "Camera permission needed";
    alert("Please allow camera access and reload.");
  }
})();
