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

const busMarkers = new Map();
const stopMarkers = new Map();
const locateBtn = document.getElementById("locate-btn");
const radiusSelect = document.getElementById("radius-select");
const lastUpdatedEl = document.getElementById("last-updated");
const locationStatusEl = document.getElementById("location-status");

let userLocation = null;
let userMarker = null;
let backendOnline = false;
let passengerTrackingInterval = null;
let locationPollInFlight = false;

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

function upsertBus(bus) {
  if (!hasLeaflet) {
    return;
  }
  const distToUser = bus.distanceToUserKm == null ? "N/A" : `${bus.distanceToUserKm} km`;
  const text = `<strong>Bus ${bus.routeNo}</strong><br/>To: ${bus.destination}<br/>Near: ${bus.nearestStop.stopName}<br/>ETA: ${bus.nearestStop.etaMin} min<br/>From you: ${distToUser}`;

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
    host.innerHTML = '<article class="arrival-card"><div class="meta">No live buses found for selected radius.</div></article>';
    return;
  }
  buses.forEach((bus) => {
    const card = document.createElement("article");
    card.className = "arrival-card";
    const userDistance = bus.distanceToUserKm == null ? "N/A" : `${bus.distanceToUserKm} km`;
    card.innerHTML = `
      <div><strong>Route ${bus.routeNo}</strong><span class="badge bus">Live</span></div>
      <div class="meta">Destination: ${bus.destination}</div>
      <div class="meta">Closest stop: ${bus.nearestStop.stopName} <span class="badge stop">Stop</span></div>
      <div class="meta">ETA to stop: ${bus.nearestStop.etaMin} min</div>
      <div class="meta">Distance from you: ${userDistance}</div>
      <div class="meta">GPS update: ${formatTime(bus.lastUpdated)}</div>
    `;
    host.appendChild(card);
  });
}

function setUserLocation(lat, lng) {
  userLocation = { lat, lng };
  locationStatusEl.textContent = `Tracking your location: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
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
  map.setView([lat, lng], 14);
}

function requestPassengerLocationUpdate() {
  if (!navigator.geolocation || locationPollInFlight) {
    return;
  }

  locationPollInFlight = true;
  navigator.geolocation.getCurrentPosition(
    (p) => {
      locationPollInFlight = false;
      setUserLocation(p.coords.latitude, p.coords.longitude);
      if (backendOnline) fetchLiveBuses().catch(() => {});
    },
    () => {
      locationPollInFlight = false;
      locationStatusEl.textContent = "Location permission denied or unavailable.";
      stopPassengerLocationTracking();
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

function startPassengerLocationTracking() {
  if (passengerTrackingInterval) {
    return;
  }
  locationStatusEl.textContent = "Starting live passenger tracking...";
  requestPassengerLocationUpdate();
  passengerTrackingInterval = setInterval(requestPassengerLocationUpdate, 1000);
  locateBtn.textContent = "Stop tracking";
}

function stopPassengerLocationTracking() {
  if (!passengerTrackingInterval) {
    return;
  }
  clearInterval(passengerTrackingInterval);
  passengerTrackingInterval = null;
  locationPollInFlight = false;
  locateBtn.textContent = "Use my location";
}

async function loadStops() {
  const res = await fetch("/api/stops");
  if (!res.ok) throw new Error("stops failed");
  const data = await res.json();
  data.busStops.forEach(upsertStop);
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
    { id: "bus-101", routeNo: "101", destination: "Railway Junction", lat: 12.973, lng: 77.591, headingDeg: 65 },
    { id: "bus-224", routeNo: "224", destination: "City Hospital", lat: 12.969, lng: 77.597, headingDeg: 130 },
    { id: "bus-308", routeNo: "308", destination: "Market Circle", lat: 12.9675, lng: 77.5905, headingDeg: 25 }
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
  if (passengerTrackingInterval) {
    stopPassengerLocationTracking();
    return;
  }
  startPassengerLocationTracking();
});

radiusSelect.addEventListener("change", () => {
  if (backendOnline) fetchLiveBuses().catch(() => {});
});

bootstrapOnlineMode().catch(() => {
  locationStatusEl.textContent = "Server not reachable. Running offline demo mode.";
  runOfflineDemo();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  });
}

window.addEventListener("beforeunload", () => {
  stopPassengerLocationTracking();
});
