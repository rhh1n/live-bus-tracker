# Android Driver App (Screen-Off Tracking)

This is a native Android starter app for driver-side live GPS tracking.
It sends location updates to your existing backend:
- `POST /api/driver/login`
- `POST /api/driver/location`
- `POST /api/driver/stop`

## Open in Android Studio
1. Open Android Studio.
2. Select **Open**.
3. Choose folder: `android-driver-app`.
4. Let Gradle sync complete.

## Run
1. Build and run on an Android phone (recommended Android 10+).
2. In app:
   - Backend URL: `https://live-bus-tracker-mska.onrender.com`
   - Bus ID / Source / Destination
   - PIN: `13579`
3. Tap **Grant Permissions**.
4. Tap **Unlock Driver**.
5. Tap **Start Live Tracking**.

## Important phone settings for reliability
1. App info -> Battery -> **Unrestricted** (or remove battery optimization).
2. Location -> **Allow all the time**.
3. Keep internet on.

## Notes
- Tracking runs via foreground service and notification, so it continues when screen is off.
- Tap **Stop Tracking** to remove bus immediately from passenger live map.

