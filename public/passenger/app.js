const hasLeaflet = typeof L !== "undefined";
const map = hasLeaflet ? L.map("map").setView([12.9716, 77.5946], 14) : null;

if (hasLeaflet) {
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);
} else {
  const mapHost = document.getElementById("map");
  mapHost.innerHTML = "<div style='padding:12px;color:#6c7a90'>Map unavailable (internet blocked). Arrivals list still works.</div>";
}

function refreshMapLayout(delayMs = 80) {
  if (!hasLeaflet) {
    return;
  }
  setTimeout(() => {
    map.invalidateSize();
  }, delayMs);
}

if (hasLeaflet) {
  window.addEventListener("resize", () => refreshMapLayout(90));
  window.addEventListener("orientationchange", () => refreshMapLayout(240));
  window.addEventListener("pageshow", () => refreshMapLayout(120));
}

const busMarkers = new Map();
const stopMarkers = new Map();
const locateBtn = document.getElementById("locate-btn");
const manualLocateBtn = document.getElementById("manual-locate-btn");
const radiusSelect = document.getElementById("radius-select");
const lastUpdatedEl = document.getElementById("last-updated");
const locationStatusEl = document.getElementById("location-status");

let userLocation = null;
let userMarker = null;
let backendOnline = false;
let passengerWatchId = null;
let hasCenteredOnUser = false;
let manualPickMode = false;
let coarseFixCount = 0;
let hasReliableFix = false;

const COARSE_LOCATION_LIMIT_M = 3000;
const HIGH_ACCURACY_M = 120;
const APPROXIMATE_ACCURACY_M = 1000;
const COARSE_FIX_RETRY_LIMIT = 3;

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function distanceKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * (2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)));
}

function nearestStop(bus, busStops) {
  let best = busStops[0];
  let bestD = distanceKm(bus.lat, bus.lng, best.lat, best.lng);
  for (let i = 1; i < busStops.length; i += 1) {
    const stop = busStops[i];
    const d = distanceKm(bus.lat, bus.lng, stop.lat, stop.lng);
    if (d < bestD) {
      best = stop;
      bestD = d;
    }
  }
  return {
    stopId: best.id,
    stopName: best.name,
    distanceKm: Number(bestD.toFixed(2)),
    etaMin: Math.max(1, Math.round((bestD / 24) * 60))
  };
}

function upsertStop(stop) {
  if (!hasLeaflet || stopMarkers.has(stop.id)) {
    return;
  }
  const marker = L.circleMarker([stop.lat, stop.lng], {
    radius: 8,
    color: "#ff7a18",
    fillColor: "#ff7a18",
    fillOpacity: 0.7,
    weight: 2
  }).addTo(map);
  marker.bindPopup(`<strong>${stop.name}</strong><br/><span>Bus Stand</span>`);
  stopMarkers.set(stop.id, marker);
}

function focusMapOnServiceArea(busStops) {
  if (!hasLeaflet || !Array.isArray(busStops) || !busStops.length || userLocation) {
    return;
  }
  const bounds = L.latLngBounds(busStops.map((stop) => [stop.lat, stop.lng]));
  if (bounds.isValid()) {
    map.fitBounds(bounds.pad(0.2), { maxZoom: 14 });
  }
}

function upsertBus(bus) {
  if (!hasLeaflet) {
    return;
  }
  const distToUser = bus.distanceToUserKm == null ? "N/A" : `${bus.distanceToUserKm} km`;
  const source = bus.source || "Unknown";
  const destination = bus.destination || "Unknown";
  const text = `<strong>Bus ${bus.id}</strong><br/>Trip: ${source} -> ${destination}<br/>ETA: ${bus.nearestStop.etaMin} min<br/>From you: ${distToUser}`;

  if (!busMarkers.has(bus.id)) {
    const marker = L.marker([bus.lat, bus.lng]).addTo(map);
    marker.bindPopup(text);
    busMarkers.set(bus.id, marker);
    return;
  }
  const marker = busMarkers.get(bus.id);
  marker.setLatLng([bus.lat, bus.lng]);
  marker.setPopupContent(text);
}

function clearOldBusMarkers(currentBusIds) {
  if (!hasLeaflet) {
    return;
  }
  Array.from(busMarkers.keys()).forEach((busId) => {
    if (currentBusIds.has(busId)) {
      return;
    }
    map.removeLayer(busMarkers.get(busId));
    busMarkers.delete(busId);
  });
}

function renderArrivals(buses) {
  const host = document.getElementById("arrivals");
  host.innerHTML = "";
  if (!buses.length) {
    host.innerHTML =
      '<article class="arrival-card" style="--stagger-index:0"><div class="meta">No live buses found for selected radius.</div></article>';
    return;
  }
  buses.forEach((bus, index) => {
    const card = document.createElement("article");
    card.className = "arrival-card";
    card.style.setProperty("--stagger-index", String(index));
    const userDistance = bus.distanceToUserKm == null ? "N/A" : `${bus.distanceToUserKm} km`;
    const source = bus.source || "Unknown";
    const destination = bus.destination || "Unknown";
    card.innerHTML = `
      <div><strong>Bus ${bus.id}</strong><span class="badge bus">Live</span></div>
      <div class="meta">Trip: ${source} -> ${destination}</div>
      <div class="meta">ETA: ${bus.nearestStop.etaMin} min</div>
      <div class="meta">Distance from you: ${userDistance}</div>
      <div class="meta">GPS update: ${formatTime(bus.lastUpdated)}</div>
    `;
    host.appendChild(card);
  });
}

function setUserLocation(lat, lng, accuracyMeters = null, source = "gps") {
  userLocation = { lat, lng };
  if (source === "gps" || source === "manual") {
    hasReliableFix = true;
  }
  const accuracyKnown = Number.isFinite(accuracyMeters);
  const accuracySuffix = accuracyKnown ? ` (+-${Math.round(accuracyMeters)} m)` : "";

  if (source === "manual") {
    locationStatusEl.textContent = `Manual location set: ${lat.toFixed(5)}, ${lng.toFixed(5)}.`;
  } else if (accuracyKnown && accuracyMeters <= HIGH_ACCURACY_M) {
    locationStatusEl.textContent = `High-accuracy GPS: ${lat.toFixed(5)}, ${lng.toFixed(5)}${accuracySuffix}`;
  } else if (accuracyKnown && accuracyMeters <= APPROXIMATE_ACCURACY_M) {
    locationStatusEl.textContent = `Tracking your location: ${lat.toFixed(5)}, ${lng.toFixed(5)}${accuracySuffix}`;
  } else if (accuracyKnown) {
    locationStatusEl.textContent = `Approximate location: ${lat.toFixed(5)}, ${lng.toFixed(5)}${accuracySuffix}. Use "Set on map" if this is wrong.`;
  } else {
    locationStatusEl.textContent = `Tracking your location: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }

  if (!hasLeaflet) {
    return;
  }
  if (!userMarker) {
    userMarker = L.circleMarker([lat, lng], {
      radius: 9,
      color: "#0057d9",
      fillColor: "#0057d9",
      fillOpacity: 0.75,
      weight: 2
    }).addTo(map);
    userMarker.bindPopup("You are here");
  } else {
    userMarker.setLatLng([lat, lng]);
  }

  if (!hasCenteredOnUser || source === "manual") {
    map.setView([lat, lng], 14);
    hasCenteredOnUser = true;
  }
}

function resolveGeolocationError(error) {
  if (!error) {
    return "Location permission denied or unavailable.";
  }
  if (error.code === 1) {
    return "Location permission denied. Enable location permission for this site.";
  }
  if (error.code === 2) {
    return "Unable to detect GPS location. Turn on device location services.";
  }
  if (error.code === 3) {
    return "GPS timed out. Move to open sky and keep internet/location on.";
  }
  return "Location permission denied or unavailable.";
}

function startPassengerLocationTracking() {
  if (passengerWatchId !== null || !navigator.geolocation) {
    return;
  }
  manualPickMode = false;
  coarseFixCount = 0;
  manualLocateBtn.textContent = "Set on map";
  locationStatusEl.textContent = "Waiting for accurate GPS fix...";
  passengerWatchId = navigator.geolocation.watchPosition(
    (p) => {
      const accuracy = p.coords.accuracy;
      if (Number.isFinite(accuracy) && accuracy > COARSE_LOCATION_LIMIT_M) {
        coarseFixCount += 1;
        locationStatusEl.textContent = `Location is too coarse (~${(accuracy / 1000).toFixed(1)} km). Move outdoors or use "Set on map".`;
        if (!hasReliableFix && coarseFixCount >= COARSE_FIX_RETRY_LIMIT) {
          stopPassengerLocationTracking({ keepStatusText: true });
        }
        return;
      }
      coarseFixCount = 0;
      setUserLocation(p.coords.latitude, p.coords.longitude, accuracy, "gps");
      if (backendOnline) fetchLiveBuses().catch(() => {});
    },
    (err) => {
      locationStatusEl.textContent = resolveGeolocationError(err);
      stopPassengerLocationTracking({ keepStatusText: true });
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
  locateBtn.textContent = "Stop tracking";
}

function stopPassengerLocationTracking(options = {}) {
  const keepStatusText = options.keepStatusText === true;
  if (passengerWatchId !== null) {
    navigator.geolocation.clearWatch(passengerWatchId);
    passengerWatchId = null;
  }
  locateBtn.textContent = "Use my location";
  if (keepStatusText) {
    return;
  }
  if (!userLocation) {
    locationStatusEl.textContent = "Passenger location not set.";
    return;
  }
  locationStatusEl.textContent = `Tracking paused at ${userLocation.lat.toFixed(5)}, ${userLocation.lng.toFixed(5)}.`;
}

function toggleManualPickMode() {
  if (!hasLeaflet) {
    locationStatusEl.textContent = "Map is not available. Cannot set location manually.";
    return;
  }

  if (manualPickMode) {
    manualPickMode = false;
    manualLocateBtn.textContent = "Set on map";
    if (userLocation) {
      locationStatusEl.textContent = `Manual selection cancelled. Current location: ${userLocation.lat.toFixed(5)}, ${userLocation.lng.toFixed(5)}.`;
    } else {
      locationStatusEl.textContent = "Manual selection cancelled.";
    }
    return;
  }

  stopPassengerLocationTracking({ keepStatusText: true });
  manualPickMode = true;
  manualLocateBtn.textContent = "Cancel map pick";
  locationStatusEl.textContent = "Tap on the map to set your exact location.";
}

async function loadStops() {
  const res = await fetch("/api/stops");
  if (!res.ok) throw new Error("stops failed");
  const data = await res.json();
  data.busStops.forEach(upsertStop);
  focusMapOnServiceArea(data.busStops);
}

async function fetchLiveBuses() {
  const params = new URLSearchParams();
  params.set("radiusKm", radiusSelect.value);
  if (userLocation) {
    params.set("lat", String(userLocation.lat));
    params.set("lng", String(userLocation.lng));
  }
  const res = await fetch(`/api/buses/live?${params.toString()}`);
  if (!res.ok) throw new Error("live failed");
  const payload = await res.json();
  const ids = new Set();
  payload.buses.forEach((bus) => {
    ids.add(bus.id);
    upsertBus(bus);
  });
  clearOldBusMarkers(ids);
  renderArrivals(payload.buses);
  lastUpdatedEl.textContent = `Last updated: ${formatTime(payload.updatedAt)} (server live data)`;
}

async function bootstrapOnlineMode() {
  await loadStops();
  refreshMapLayout(150);
  await fetchLiveBuses();
  backendOnline = true;
  if (typeof io === "function") {
    const socket = io();
    socket.on("bus:update", () => fetchLiveBuses().catch(() => {}));
  }
  setInterval(() => fetchLiveBuses().catch(() => {}), 15000);
}

function runOfflineDemo() {
  const busStops = [
    { id: "stop-1", name: "Central Bus Stand", lat: 12.9719, lng: 77.5938 },
    { id: "stop-2", name: "Market Circle", lat: 12.9755, lng: 77.5993 },
    { id: "stop-3", name: "City Hospital Stop", lat: 12.9682, lng: 77.6012 },
    { id: "stop-4", name: "Railway Junction", lat: 12.9665, lng: 77.5881 }
  ];
  const buses = [
    {
      id: "bus-101",
      routeNo: "101",
      source: "Central Bus Stand",
      destination: "Railway Junction",
      lat: 12.973,
      lng: 77.591,
      headingDeg: 65
    },
    {
      id: "bus-224",
      routeNo: "224",
      source: "Market Circle",
      destination: "City Hospital",
      lat: 12.969,
      lng: 77.597,
      headingDeg: 130
    },
    {
      id: "bus-308",
      routeNo: "308",
      source: "City Hospital Stop",
      destination: "Market Circle",
      lat: 12.9675,
      lng: 77.5905,
      headingDeg: 25
    }
  ];
  busStops.forEach(upsertStop);

  function tick() {
    buses.forEach((bus) => {
      const step = 0.00035;
      const h = (bus.headingDeg * Math.PI) / 180;
      bus.lat += step * Math.cos(h);
      bus.lng += step * Math.sin(h);
      if (Math.random() < 0.08) bus.headingDeg = (bus.headingDeg + (Math.random() - 0.5) * 60 + 360) % 360;
    });

    const payload = buses.map((b) => ({
      ...b,
      distanceToUserKm: userLocation ? Number(distanceKm(userLocation.lat, userLocation.lng, b.lat, b.lng).toFixed(2)) : null,
      nearestStop: nearestStop(b, busStops),
      lastUpdated: new Date().toISOString()
    }));

    const ids = new Set();
    payload.forEach((bus) => {
      ids.add(bus.id);
      upsertBus(bus);
    });
    clearOldBusMarkers(ids);
    renderArrivals(payload);
    lastUpdatedEl.textContent = `Last updated: ${formatTime(new Date().toISOString())} (offline demo mode)`;
  }

  tick();
  setInterval(tick, 3000);
}

locateBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    locationStatusEl.textContent = "Geolocation not supported in this browser.";
    return;
  }
  if (passengerWatchId !== null) {
    stopPassengerLocationTracking();
    return;
  }
  startPassengerLocationTracking();
});

if (manualLocateBtn) {
  manualLocateBtn.addEventListener("click", toggleManualPickMode);
}

if (hasLeaflet) {
  map.on("click", (event) => {
    if (!manualPickMode) {
      return;
    }
    manualPickMode = false;
    manualLocateBtn.textContent = "Set on map";
    setUserLocation(event.latlng.lat, event.latlng.lng, 25, "manual");
    if (backendOnline) fetchLiveBuses().catch(() => {});
  });
}

radiusSelect.addEventListener("change", () => {
  if (backendOnline) fetchLiveBuses().catch(() => {});
});

bootstrapOnlineMode().catch(() => {
  locationStatusEl.textContent = "Server not reachable. Running offline demo mode.";
  runOfflineDemo();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => {
        registrations.forEach((registration) => {
          try {
            const scopePath = new URL(registration.scope).pathname;
            if (scopePath === "/") {
              registration.unregister().catch(() => {});
            }
          } catch (_err) {
            // ignore invalid scope URL parsing
          }
        });
      })
      .catch(() => {});

    navigator.serviceWorker
      .register("/passenger/service-worker.js", { scope: "/passenger/" })
      .catch(() => {});
  });
}

window.addEventListener("beforeunload", () => {
  stopPassengerLocationTracking();
});
