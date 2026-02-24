const busIdEl = document.getElementById("bus-id");
const routeNoEl = document.getElementById("route-no");
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
  const line = document.createElement("div");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.prepend(line);
}

function setStatus(msg) {
  statusEl.textContent = msg;
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
    routeNo: routeNoEl.value.trim(),
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

    lastEl.textContent = `Last GPS sent: ${payload.lat.toFixed(6)}, ${payload.lng.toFixed(6)}`;
    setStatus("Live tracking active.");
    addLog(`Uploaded ${payload.busId} @ ${payload.lat.toFixed(5)}, ${payload.lng.toFixed(5)}`);
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
  } catch (err) {
    driverToken = null;
    setStatus("Invalid PIN.");
    addLog(err.message);
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
    setStatus("Bus ID is required.");
    return;
  }

  setStatus("Requesting GPS permission...");
  watchId = navigator.geolocation.watchPosition(
    (position) => {
      sendLocation(position);
    },
    (error) => {
      setStatus("GPS error. Check location permission.");
      addLog(`GPS error: ${error.message}`);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000
    }
  );
}

function stopTracking() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  setStatus("Tracking stopped.");
}

startBtn.addEventListener("click", startTracking);
stopBtn.addEventListener("click", stopTracking);
unlockBtn.addEventListener("click", unlockDriver);
