const busIdEl = document.getElementById("bus-id");
const sourceEl = document.getElementById("source");
const destinationEl = document.getElementById("destination");
const pinEl = document.getElementById("driver-pin");
const unlockBtn = document.getElementById("unlock-btn");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const statusEl = document.getElementById("driver-status");
const lastEl = document.getElementById("driver-last");
const logEl = document.getElementById("driver-log");

let watchId = null;
let sendInFlight = false;
let driverToken = null;
let tokenExpiryIso = null;
let latestPosition = null;
let uploadIntervalId = null;
let firstFixSent = false;

const DRIVER_UPLOAD_INTERVAL_MS = 2000;
const FORM_STORAGE_KEY = "bus-tracker-driver-form-v1";
const SESSION_STORAGE_KEY = "bus-tracker-driver-session-v1";
const MAX_TEXT_LEN = 80;
const MAX_BUS_ID_LEN = 40;

function formatClock(dateLike = new Date()) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function normalizeText(value, maxLen = MAX_TEXT_LEN) {
  const cleaned = `${value || ""}`
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, maxLen);
}

function getFormValues() {
  return {
    busId: normalizeText(busIdEl.value, MAX_BUS_ID_LEN),
    source: normalizeText(sourceEl.value),
    destination: normalizeText(destinationEl.value)
  };
}

function hasRequiredFields() {
  const form = getFormValues();
  return !!form.busId && !!form.source && !!form.destination;
}

function addLog(msg) {
  if (!logEl) {
    return;
  }
  const line = document.createElement("div");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.prepend(line);
  while (logEl.childElementCount > 120) {
    logEl.removeChild(logEl.lastChild);
  }
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function saveFormState() {
  try {
    const form = getFormValues();
    localStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(form));
  } catch (_err) {
    // localStorage unavailable
  }
}

function restoreFormState() {
  try {
    const raw = localStorage.getItem(FORM_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      busIdEl.value = normalizeText(data.busId, MAX_BUS_ID_LEN);
      sourceEl.value = normalizeText(data.source);
      destinationEl.value = normalizeText(data.destination);
    }
  } catch (_err) {
    // ignore corrupt storage
  }
}

function saveSessionState() {
  if (!driverToken || !tokenExpiryIso) {
    return;
  }
  try {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        token: driverToken,
        expiresAt: tokenExpiryIso
      })
    );
  } catch (_err) {
    // localStorage unavailable
  }
}

function clearSessionState() {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch (_err) {
    // localStorage unavailable
  }
}

function tokenIsValid(expiresAtIso) {
  if (!expiresAtIso) {
    return false;
  }
  const expiresAt = new Date(expiresAtIso).getTime();
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}

function restoreSessionState() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") {
      return;
    }
    if (!tokenIsValid(data.expiresAt)) {
      clearSessionState();
      return;
    }
    driverToken = `${data.token || ""}`.trim();
    tokenExpiryIso = `${data.expiresAt || ""}`.trim();
    if (driverToken && tokenExpiryIso) {
      setStatus(`Driver session restored. Valid until ${formatClock(tokenExpiryIso)}.`);
      addLog("Recovered active driver session.");
    }
  } catch (_err) {
    clearSessionState();
  }
}

function clearDriverSession() {
  driverToken = null;
  tokenExpiryIso = null;
  clearSessionState();
}

function setControlState() {
  const tracking = watchId !== null;
  const unlocked = !!driverToken && tokenIsValid(tokenExpiryIso);
  startBtn.disabled = tracking || !unlocked || !hasRequiredFields();
  stopBtn.disabled = !tracking;
  unlockBtn.disabled = tracking;
}

function resolveGeolocationError(error) {
  if (!error) {
    return "GPS unavailable.";
  }
  if (error.code === 1) {
    return "Location permission denied. Allow location access.";
  }
  if (error.code === 2) {
    return "GPS signal unavailable. Move to open sky.";
  }
  if (error.code === 3) {
    return "GPS request timed out. Try again.";
  }
  return "GPS error.";
}

async function sendLocation(position) {
  if (sendInFlight) {
    return;
  }
  sendInFlight = true;

  if (!driverToken || !tokenIsValid(tokenExpiryIso)) {
    clearDriverSession();
    stopTracking({ keepStatusText: true });
    setStatus("Driver session expired. Unlock again.");
    setControlState();
    sendInFlight = false;
    return;
  }

  const form = getFormValues();
  const payload = {
    busId: form.busId,
    source: form.source,
    destination: form.destination,
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    speedKmph: Math.max(0, (position.coords.speed || 0) * 3.6),
    headingDeg: Number.isFinite(position.coords.heading) ? position.coords.heading : 0
  };

  try {
    const res = await fetch("/api/driver/location", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-driver-token": driverToken
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401) {
        clearDriverSession();
        setControlState();
      }
      throw new Error(`Upload failed (${res.status}): ${text}`);
    }

    const accuracyText = Number.isFinite(position.coords.accuracy)
      ? ` (+-${Math.round(position.coords.accuracy)} m)`
      : "";
    lastEl.textContent = `Last updated: ${formatClock()} | GPS: ${payload.lat.toFixed(6)}, ${payload.lng.toFixed(6)}${accuracyText}`;
    setStatus("Live tracking active.");
    addLog(
      `Uploaded ${payload.busId} (${payload.source || "Unknown"} -> ${payload.destination || "Unknown"}) @ ${payload.lat.toFixed(5)}, ${payload.lng.toFixed(5)}`
    );
  } catch (err) {
    setStatus("Error while sending GPS. See log.");
    addLog(err.message);
  } finally {
    sendInFlight = false;
  }
}

async function unlockDriver() {
  const pin = normalizeText(pinEl.value, 24);
  if (!pin) {
    setStatus("Enter driver PIN.");
    return;
  }

  setStatus("Verifying driver PIN...");
  try {
    const res = await fetch("/api/driver/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin })
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Unlock failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    driverToken = `${data.token || ""}`.trim();
    tokenExpiryIso = `${data.expiresAt || ""}`.trim();
    saveSessionState();
    setStatus(`Driver unlocked. Session until ${formatClock(tokenExpiryIso)}.`);
    addLog("Driver PIN verified.");
    setControlState();
  } catch (err) {
    clearDriverSession();
    setStatus("Invalid PIN.");
    addLog(err.message);
    setControlState();
  }
}

function startTracking() {
  if (!navigator.geolocation) {
    setStatus("Geolocation not supported in this browser.");
    return;
  }
  if (!driverToken || !tokenIsValid(tokenExpiryIso)) {
    clearDriverSession();
    setStatus("Unlock driver first.");
    setControlState();
    return;
  }
  if (watchId !== null) {
    setStatus("Already tracking.");
    return;
  }

  const form = getFormValues();
  busIdEl.value = form.busId;
  sourceEl.value = form.source;
  destinationEl.value = form.destination;
  saveFormState();

  if (!form.busId) {
    setStatus("Bus is required.");
    return;
  }

  if (!form.source) {
    setStatus("Source is required.");
    return;
  }

  if (!form.destination) {
    setStatus("Destination is required.");
    return;
  }

  setStatus("Requesting GPS permission...");
  latestPosition = null;
  firstFixSent = false;

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      latestPosition = position;
      if (!firstFixSent) {
        sendLocation(position);
        firstFixSent = true;
      }
    },
    (error) => {
      const message = resolveGeolocationError(error);
      setStatus(message);
      addLog(`GPS error: ${error.message || message}`);
      stopTracking({ keepStatusText: true });
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000
    }
  );
  uploadIntervalId = setInterval(() => {
    if (latestPosition) {
      sendLocation(latestPosition);
    }
  }, DRIVER_UPLOAD_INTERVAL_MS);
  setControlState();
  setStatus("Waiting for first GPS fix... Updates every 2s.");
}

function stopTracking(options = {}) {
  const keepStatusText = options.keepStatusText === true;
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (uploadIntervalId !== null) {
    clearInterval(uploadIntervalId);
    uploadIntervalId = null;
  }
  latestPosition = null;
  firstFixSent = false;
  setControlState();
  if (!keepStatusText) {
    setStatus("Tracking stopped.");
  }
}

startBtn.addEventListener("click", startTracking);
stopBtn.addEventListener("click", stopTracking);
unlockBtn.addEventListener("click", unlockDriver);

[busIdEl, sourceEl, destinationEl].forEach((field) => {
  field.addEventListener("input", () => {
    if (field === busIdEl) {
      field.value = normalizeText(field.value, MAX_BUS_ID_LEN);
    } else {
      field.value = normalizeText(field.value);
    }
    saveFormState();
    setControlState();
  });
});

window.addEventListener("online", () => {
  if (watchId !== null) {
    setStatus("Online. Uploading live GPS...");
  }
});

window.addEventListener("offline", () => {
  setStatus("You are offline. GPS uploads will retry when internet returns.");
});

window.addEventListener("beforeunload", (event) => {
  if (watchId === null) {
    return;
  }
  event.preventDefault();
  event.returnValue = "";
});

restoreFormState();
restoreSessionState();
setControlState();
