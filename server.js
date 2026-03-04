const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DRIVER_API_KEY = process.env.DRIVER_API_KEY || "change-this-driver-key";
const DRIVER_LOGIN_PIN = process.env.DRIVER_LOGIN_PIN || "1234";
const ENABLE_SIMULATION = process.env.ENABLE_SIMULATION === "true";
const STALE_AFTER_MS = 2 * 60 * 1000;
const DRIVER_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_RADIUS_KM = 0.1;
const DEFAULT_RADIUS_KM = 50;
const MAX_RADIUS_KM = 50;
const LOCATION_HISTORY_LIMIT = 120;
const JSON_BODY_LIMIT = "32kb";
const MAX_TEXT_FIELD_LEN = 80;
const MAX_BUS_ID_LEN = 40;
const MAX_ROUTE_NO_LEN = 24;
const MAX_SPEED_KMPH = 140;
const LOGIN_RATE_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_RATE_MAX = 20;
const LOCATION_RATE_WINDOW_MS = 60 * 1000;
const LOCATION_RATE_MAX = 240;
const PASSENGER_WEB_ROOT = path.join(__dirname, "public", "passenger");
const DRIVER_WEB_ROOT = path.join(__dirname, "public", "driver");

app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(express.json({ limit: JSON_BODY_LIMIT }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "geolocation=(self)");
  if (`${req.headers["x-forwarded-proto"] || ""}`.includes("https")) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

app.use("/passenger", express.static(PASSENGER_WEB_ROOT, { redirect: false }));
app.use(
  "/driver",
  (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  },
  express.static(DRIVER_WEB_ROOT, { redirect: false })
);

app.get("/", (_req, res) => {
  res.redirect(302, "/passenger");
});

app.get("/passenger", (_req, res) => {
  res.sendFile(path.join(PASSENGER_WEB_ROOT, "index.html"));
});

app.get("/driver", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(DRIVER_WEB_ROOT, "index.html"));
});

app.get("/service-worker.js", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.type("application/javascript").send(`
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
      clients.forEach((client) => client.navigate(client.url));
    })()
  );
});
  `);
});

const busStops = [
  { id: "stop-1", name: "Central Bus Stand", lat: 12.9719, lng: 77.5938 },
  { id: "stop-2", name: "Market Circle", lat: 12.9755, lng: 77.5993 },
  { id: "stop-3", name: "City Hospital Stop", lat: 12.9682, lng: 77.6012 },
  { id: "stop-4", name: "Railway Junction", lat: 12.9665, lng: 77.5881 }
];

const busState = new Map();
const driverTokens = new Map();
const busLocationHistory = new Map();
const rateLimitBuckets = new Map();

function getClientIp(req) {
  const forwarded = `${req.get("x-forwarded-for") || ""}`.trim();
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return `${req.ip || req.socket?.remoteAddress || "unknown"}`;
}

function cleanupRateLimitBuckets() {
  const now = Date.now();
  Array.from(rateLimitBuckets.entries()).forEach(([key, bucket]) => {
    if (now >= bucket.resetAt) {
      rateLimitBuckets.delete(key);
    }
  });
}

function createRateLimiter(scope, windowMs, maxHits) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${scope}:${getClientIp(req)}`;
    const current = rateLimitBuckets.get(key);

    if (!current || now >= current.resetAt) {
      rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    current.count += 1;
    if (current.count <= maxHits) {
      return next();
    }

    const retryAfterSec = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfterSec));
    return res.status(429).json({ error: "Too many requests. Please retry shortly." });
  };
}

const loginRateLimiter = createRateLimiter("driver-login", LOGIN_RATE_WINDOW_MS, LOGIN_RATE_MAX);
const locationRateLimiter = createRateLimiter("driver-location", LOCATION_RATE_WINDOW_MS, LOCATION_RATE_MAX);

function sanitizeText(value, maxLen = MAX_TEXT_FIELD_LEN) {
  const cleaned = `${value ?? ""}`
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, Math.max(1, maxLen));
}

function isValidCoordinate(lat, lng) {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function appendBusHistory(bus) {
  if (!bus?.id || !bus?.lastUpdated) {
    return;
  }
  const history = busLocationHistory.get(bus.id) || [];
  const latest = history[history.length - 1];
  if (latest?.updatedAt === bus.lastUpdated) {
    return;
  }
  history.push({
    updatedAt: bus.lastUpdated,
    lat: bus.lat,
    lng: bus.lng,
    source: bus.source || null,
    destination: bus.destination || null
  });
  if (history.length > LOCATION_HISTORY_LIMIT) {
    history.splice(0, history.length - LOCATION_HISTORY_LIMIT);
  }
  busLocationHistory.set(bus.id, history);
}

function getBusHistory(busId, limit = 6) {
  const history = busLocationHistory.get(busId) || [];
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  return history.slice(-safeLimit).reverse();
}

function toRad(value) {
  return (value * Math.PI) / 180;
}

function distanceKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return R * c;
}

function getNearestStop(lat, lng, speedKmph) {
  let nearest = busStops[0];
  let minDist = distanceKm(lat, lng, nearest.lat, nearest.lng);
  for (let i = 1; i < busStops.length; i += 1) {
    const stop = busStops[i];
    const d = distanceKm(lat, lng, stop.lat, stop.lng);
    if (d < minDist) {
      minDist = d;
      nearest = stop;
    }
  }
  const etaMin = Math.max(1, Math.round((minDist / Math.max(speedKmph || 10, 10)) * 60));
  return { stopId: nearest.id, stopName: nearest.name, distanceKm: Number(minDist.toFixed(2)), etaMin };
}

function moveBus(bus) {
  const stepKm = bus.speedKmph / 3600;
  const jitter = (Math.random() - 0.5) * 0.00015;
  const heading = toRad(bus.headingDeg + (Math.random() - 0.5) * 10);

  bus.lat += stepKm * 0.009 * Math.cos(heading) + jitter;
  bus.lng += stepKm * 0.009 * Math.sin(heading) + jitter;

  if (Math.random() < 0.04) {
    bus.headingDeg = (bus.headingDeg + (Math.random() - 0.5) * 50 + 360) % 360;
  }

  const bounds = {
    minLat: 12.962,
    maxLat: 12.98,
    minLng: 77.584,
    maxLng: 77.606
  };

  if (bus.lat < bounds.minLat || bus.lat > bounds.maxLat) {
    bus.headingDeg = (180 - bus.headingDeg + 360) % 360;
    bus.lat = Math.min(Math.max(bus.lat, bounds.minLat), bounds.maxLat);
  }

  if (bus.lng < bounds.minLng || bus.lng > bounds.maxLng) {
    bus.headingDeg = (360 - bus.headingDeg + 360) % 360;
    bus.lng = Math.min(Math.max(bus.lng, bounds.minLng), bounds.maxLng);
  }
}

function listLiveBuses() {
  const now = Date.now();
  return Array.from(busState.values())
    .filter((bus) => now - new Date(bus.lastUpdated).getTime() <= STALE_AFTER_MS)
    .map((bus) => ({
      ...bus,
      nearestStop: getNearestStop(bus.lat, bus.lng, bus.speedKmph),
      updateHistory: getBusHistory(bus.id, 6).map((entry) => entry.updatedAt)
    }));
}

function buildPayload() {
  return {
    updatedAt: new Date().toISOString(),
    busStops,
    buses: listLiveBuses()
  };
}

function requireDriverKey(req, res, next) {
  const key = req.get("x-api-key");
  if (!key || key !== DRIVER_API_KEY) {
    return res.status(401).json({ error: "Unauthorized driver API key" });
  }
  return next();
}

function generateToken() {
  return `drv_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function cleanupDriverTokens() {
  const now = Date.now();
  Array.from(driverTokens.entries()).forEach(([token, meta]) => {
    if (now > meta.expiresAt) {
      driverTokens.delete(token);
    }
  });
}

function requireDriverAuth(req, res, next) {
  const key = req.get("x-api-key");
  if (key && key === DRIVER_API_KEY) {
    return next();
  }

  const token = req.get("x-driver-token");
  if (!token || !driverTokens.has(token)) {
    return res.status(401).json({ error: "Unauthorized driver auth" });
  }

  const meta = driverTokens.get(token);
  if (Date.now() > meta.expiresAt) {
    driverTokens.delete(token);
    return res.status(401).json({ error: "Driver session expired" });
  }

  return next();
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    now: new Date().toISOString(),
    liveBusCount: listLiveBuses().length
  });
});

app.get("/api/stops", (_req, res) => {
  res.json({ busStops });
});

app.get("/api/buses/history", (req, res) => {
  const busId = sanitizeText(req.query.busId, MAX_BUS_ID_LEN);
  if (!busId) {
    return res.status(400).json({ error: "busId query param is required" });
  }
  const limit = Math.min(100, Math.max(1, toNumber(req.query.limit) || 20));
  const history = getBusHistory(busId, limit);
  return res.json({
    busId,
    count: history.length,
    history
  });
});

app.post("/api/driver/login", loginRateLimiter, (req, res) => {
  const pin = sanitizeText(req.body?.pin, 24);
  if (!pin || pin !== DRIVER_LOGIN_PIN) {
    return res.status(401).json({ error: "Invalid driver PIN" });
  }

  cleanupDriverTokens();
  const token = generateToken();
  const expiresAt = Date.now() + DRIVER_TOKEN_TTL_MS;
  driverTokens.set(token, { expiresAt });

  return res.json({
    ok: true,
    token,
    expiresAt: new Date(expiresAt).toISOString()
  });
});

app.get("/api/buses/live", (req, res) => {
  const lat = toNumber(req.query.lat);
  const lng = toNumber(req.query.lng);
  const latProvided = req.query.lat !== undefined;
  const lngProvided = req.query.lng !== undefined;
  if ((latProvided || lngProvided) && (lat === null || lng === null || !isValidCoordinate(lat, lng))) {
    return res.status(400).json({ error: "lat/lng must be valid coordinates." });
  }

  const requestedRadiusKm = toNumber(req.query.radiusKm);
  const radiusKm = Math.min(
    MAX_RADIUS_KM,
    Math.max(MIN_RADIUS_KM, requestedRadiusKm ?? DEFAULT_RADIUS_KM)
  );
  const buses = listLiveBuses().map((bus) => {
    const distanceToUserKm =
      lat !== null && lng !== null ? Number(distanceKm(lat, lng, bus.lat, bus.lng).toFixed(2)) : null;
    return { ...bus, distanceToUserKm };
  });

  const filtered = buses
    .filter((bus) => (bus.distanceToUserKm === null ? true : bus.distanceToUserKm <= radiusKm))
    .sort((a, b) => {
      if (a.distanceToUserKm !== null && b.distanceToUserKm !== null) {
        return a.distanceToUserKm - b.distanceToUserKm;
      }
      if (a.distanceToUserKm !== null) {
        return -1;
      }
      if (b.distanceToUserKm !== null) {
        return 1;
      }
      return new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime();
    });

  res.json({
    updatedAt: new Date().toISOString(),
    radiusKm,
    buses: filtered
  });
});

app.post("/api/driver/location", locationRateLimiter, requireDriverAuth, (req, res) => {
  const { busId, routeNo, source, destination, lat, lng, speedKmph, headingDeg } = req.body || {};
  const latN = toNumber(lat);
  const lngN = toNumber(lng);

  const busIdClean = sanitizeText(busId, MAX_BUS_ID_LEN);
  if (!busIdClean || latN === null || lngN === null) {
    return res.status(400).json({ error: "busId, lat, lng are required" });
  }
  if (!isValidCoordinate(latN, lngN)) {
    return res.status(400).json({ error: "lat/lng must be valid coordinates." });
  }

  const existing = busState.get(busIdClean);
  const routeNoClean = sanitizeText(routeNo, MAX_ROUTE_NO_LEN) || existing?.routeNo || busIdClean;
  const sourceClean = sanitizeText(source, MAX_TEXT_FIELD_LEN) || existing?.source || "Unknown";
  const destinationClean = sanitizeText(destination, MAX_TEXT_FIELD_LEN) || existing?.destination || "Unknown";
  const speed = Math.min(MAX_SPEED_KMPH, Math.max(0, toNumber(speedKmph) || existing?.speedKmph || 0));
  const heading = Math.max(0, Math.min(359, toNumber(headingDeg) || existing?.headingDeg || 0));

  const payload = {
    id: busIdClean,
    routeNo: routeNoClean,
    source: sourceClean,
    destination: destinationClean,
    lat: latN,
    lng: lngN,
    speedKmph: speed,
    headingDeg: heading,
    provider: "driver-gps",
    lastUpdated: new Date().toISOString()
  };

  busState.set(busIdClean, payload);
  appendBusHistory(payload);
  io.emit("bus:update", buildPayload());

  return res.status(202).json({
    accepted: true,
    bus: {
      ...payload,
      nearestStop: getNearestStop(payload.lat, payload.lng, payload.speedKmph)
    }
  });
});

io.on("connection", (socket) => {
  socket.emit("bus:update", buildPayload());
});

if (ENABLE_SIMULATION) {
  setInterval(() => {
    const all = Array.from(busState.values());
    all.forEach((bus) => {
      if (bus.provider === "driver-gps") {
        return;
      }
      moveBus(bus);
      bus.lastUpdated = new Date().toISOString();
      busState.set(bus.id, bus);
      appendBusHistory(bus);
    });
    io.emit("bus:update", buildPayload());
  }, 3000);
}

setInterval(() => {
  io.emit("bus:update", buildPayload());
}, 10000);

const maintenanceInterval = setInterval(() => {
  cleanupDriverTokens();
  cleanupRateLimitBuckets();
}, 5 * 60 * 1000);
if (typeof maintenanceInterval.unref === "function") {
  maintenanceInterval.unref();
}

server.listen(PORT, () => {
  console.log(`Live bus tracker running on http://localhost:${PORT}`);
  console.log(`Passenger web app: http://localhost:${PORT}/passenger`);
  console.log(`Driver web app: http://localhost:${PORT}/driver`);
  console.log(`Simulation mode: ${ENABLE_SIMULATION ? "ON" : "OFF"}`);
  console.log("Driver API endpoint: POST /api/driver/location");
});
