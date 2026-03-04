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

function setControlState() {
  const tracking = watchId !== null;
  const unlocked = !!driverToken;
  startBtn.disabled = tracking || !unlocked;
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

  if (!driverToken) {
    setStatus("Unlock driver first using PIN.");
    sendInFlight = false;
    return;
  }

  const payload = {
    busId: busIdEl.value.trim(),
    source: sourceEl.value.trim(),
    destination: destinationEl.value.trim(),
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
      throw new Error(`Upload failed (${res.status}): ${text}`);
    }

    const accuracyText = Number.isFinite(position.coords.accuracy)
      ? ` (+-${Math.round(position.coords.accuracy)} m)`
      : "";
    lastEl.textContent = `Last GPS sent: ${payload.lat.toFixed(6)}, ${payload.lng.toFixed(6)}${accuracyText}`;
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
  const pin = pinEl.value.trim();
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
    driverToken = data.token;
    setStatus(`Driver unlocked. Session until ${new Date(data.expiresAt).toLocaleTimeString()}.`);
    addLog("Driver PIN verified.");
    setControlState();
  } catch (err) {
    driverToken = null;
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
  if (!driverToken) {
    setStatus("Unlock driver first.");
    return;
  }
  if (watchId !== null) {
    setStatus("Already tracking.");
    return;
  }

  const busId = busIdEl.value.trim();
  if (!busId) {
    setStatus("Bus is required.");
    return;
  }

  if (!sourceEl.value.trim()) {
    setStatus("Source is required.");
    return;
  }

  if (!destinationEl.value.trim()) {
    setStatus("Destination is required.");
    return;
  }

  setStatus("Requesting GPS permission...");
  watchId = navigator.geolocation.watchPosition(
    (position) => {
      sendLocation(position);
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
  setControlState();
  setStatus("Waiting for first GPS fix...");
}

function stopTracking(options = {}) {
  const keepStatusText = options.keepStatusText === true;
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  setControlState();
  if (!keepStatusText) {
    setStatus("Tracking stopped.");
  }
}

startBtn.addEventListener("click", startTracking);
stopBtn.addEventListener("click", stopTracking);
unlockBtn.addEventListener("click", unlockDriver);

setControlState();
