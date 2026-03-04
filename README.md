# Live Bus Tracker (Real-World Starter)

This project is now structured for real deployments:
- Passengers see live buses in browser map
- Drivers (or bus GPS devices) push coordinates to backend
- Backend broadcasts updates via Socket.IO and serves nearby-bus APIs
- Passenger and driver UIs are isolated into separate frontend routes

## Stack
- Node.js + Express
- Socket.IO
- Leaflet + OpenStreetMap

## Quick Start
1. Install Node.js LTS: https://nodejs.org
2. Open terminal in `live-bus-tracker`
3. Install dependencies:
   `npm install`
4. Set driver API key (PowerShell):
   `$env:DRIVER_API_KEY="your-strong-key"`
5. Set driver login PIN (PowerShell):
   `$env:DRIVER_LOGIN_PIN="13579"`
6. Start server:
   `npm start`
7. Open:
   - Passenger: `http://localhost:3000/passenger`
   - Driver: `http://localhost:3000/driver`
   - Root redirects to passenger route

## Passenger Flow
- Click `Use my location`
- App queries `/api/buses/live?lat=...&lng=...&radiusKm=...`
- Passenger radius is selectable up to `50 km` (default `50 km`)
- No default/seed buses are shown; buses appear only from live driver GPS uploads
- Arrivals panel shows trip, current location, distance from user, and GPS update time

## Driver Mobile Page (Real GPS)
- Open on driver phone:
  - `https://<your-domain>/driver`
- Fill:
  - `Bus ID`, `Source`, `Destination`, `Driver PIN`
- Tap `Unlock Driver`
- Tap `Start Live Tracking`
- The page continuously uploads GPS to `/api/driver/location`
- Passenger page `https://<your-domain>/passenger` will show the bus live

## Frontend Separation (Production-Friendly)
- Passenger web app is served from `/passenger`
- Driver web app is served from `/driver`
- Passenger service worker is scoped only to `/passenger/`
- Driver web assets are served with `Cache-Control: no-store`
- Legacy root service worker path (`/service-worker.js`) is retired automatically

## Driver / GPS Device API
Endpoint:
- `POST /api/driver/location`

Headers:
- `Content-Type: application/json`
- `x-api-key: <DRIVER_API_KEY>`

Body example:
```json
{
  "busId": "bus-101",
  "source": "Central Bus Stand",
  "destination": "Railway Junction",
  "lat": 12.9722,
  "lng": 77.5954,
  "speedKmph": 28,
  "headingDeg": 80
}
```

PowerShell test call:
```powershell
$headers = @{ "x-api-key" = "your-strong-key"; "Content-Type" = "application/json" }
$body = '{"busId":"bus-101","source":"Central Bus Stand","destination":"Railway Junction","lat":12.9722,"lng":77.5954,"speedKmph":28,"headingDeg":80}'
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/driver/location" -Headers $headers -Body $body
```

## APIs
- `GET /api/health`
- `GET /api/stops`
- `GET /api/buses/live?lat=<lat>&lng=<lng>&radiusKm=<km>`
- `GET /api/buses/history?busId=<id>&limit=<n>`
- `POST /api/driver/login` (requires PIN)
- `POST /api/driver/location` (requires `x-driver-token` or `x-api-key`)
- `POST /api/driver/stop` (removes bus instantly from passenger view; requires `x-driver-token` or `x-api-key`)

## Production Next Steps
- Replace in-memory state with Redis/PostgreSQL.
- Issue per-device API keys or JWT for drivers.
- Add request signing and audit logs for every driver device.
- Ingest official route/stop data (GTFS static + GTFS-realtime).
- Add monitoring and stale-device alerts.

## Deploy For Mobile Use (HTTPS)
Use HTTPS hosting so mobile location permissions work.

### Option A: Render (easy)
1. Push this folder to a GitHub repo.
2. In Render, create `New +` -> `Web Service`.
3. Connect your repo.
4. Render auto-detects `render.yaml`.
5. Set secret env var:
   - `DRIVER_API_KEY=your-strong-key`
   - `DRIVER_LOGIN_PIN=13579`
   - `BUS_STALE_AFTER_MS=15000`
6. Deploy and open the generated `https://...onrender.com` URL on mobile.

### Option B: Railway
1. Push this folder to GitHub.
2. In Railway, `New Project` -> `Deploy from GitHub repo`.
3. Add env vars:
   - `DRIVER_API_KEY=your-strong-key`
   - `DRIVER_LOGIN_PIN=13579`
   - `ENABLE_SIMULATION=false`
   - `BUS_STALE_AFTER_MS=15000`
4. Deploy and open the public HTTPS URL on mobile.

## Install As Mobile App (PWA)
After deployment:
- Open `https://<your-domain>/passenger` in mobile browser.
- Chrome Android: menu -> `Add to Home screen`.
- iPhone Safari: share -> `Add to Home Screen`.
