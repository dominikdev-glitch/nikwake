# NikWake

NikWake is a website wake bot. Add a URL, choose a cadence, and the scheduler sends real HTTP requests to keep the site warm.

## Run locally

```powershell
npm install
npm run dev:all
```

Open http://localhost:5173. The dashboard runs on Vite and the scheduler API runs on port 8787.

## Firebase authentication

1. Create a Firebase project and register a Web app.
2. Enable Google and/or Email/Password under Authentication providers.
3. Create a Firestore database in the Firebase Console.
4. Copy `.env.example` to `.env` and fill in the Firebase Web app values.
5. For the server, create a Firebase service account and add its Admin values. The web API key is safe for the browser, but cannot authenticate server-side Firestore writes.
6. Restart `npm run dev:all`.

The dashboard requires a Firebase session and sends its ID token with every API request. For production API enforcement, add the Firebase Admin service-account values from `.env.example` and set `NIKWAKE_REQUIRE_AUTH=true`.

## What it does

- Persists monitors in `server/data.json`
- Sends scheduled HTTP GET requests every 30 seconds when a monitor is due
- Supports 1, 5, 10, 15, 30 minute, and hourly schedules
- Configures retry count and accepted HTTP status code/ranges per monitor
- Supports manual wake, pause/resume, and delete
- Records response time, HTTP status, errors, failure streaks, and recent activity
- Marks failed monitors as `Degraded` and recovers monitors safely after a restart
- Rejects non-HTTP URLs, credential-bearing URLs, and private network targets
- Stops a request after 15 seconds
- Requires Firebase authentication in the dashboard

## Deploy on Render

This repository includes `render.yaml` for a free Render web service. It builds the Vite frontend, serves it from the Node process, and runs the scheduler.

1. Push the repository to GitHub.
2. In Render, choose **New > Blueprint** and select the repository.
3. Add the Firebase Web values as the `VITE_FIREBASE_*` environment variables.
4. Add the complete Firebase Admin JSON as the `FIREBASE_ADMIN_JSON` Render secret. You may use the split `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY` variables instead, but do not use both formats.
5. Deploy. Render uses `npm ci && npm run build` and starts with `npm run bot`.

The Render Blueprint uses Firebase Firestore for durable monitor storage. The server requires Firebase Admin credentials for this mode. Local development falls back to `server/data.json` unless `NIKWAKE_STORAGE=firestore` is enabled.

If Render logs `5 NOT_FOUND` while starting, open Firebase Console for the same `FIREBASE_PROJECT_ID`, choose **Build > Firestore Database > Create database**, select a location, and redeploy. The app creates the `nikwake/state` document automatically on first start; it cannot create the Firestore database itself. Check `/health`: it should report `storage: firestore` and `firebaseAdminConfigured: true`.

## Keep Render awake with cron

After deploying, create an external cron job that sends a `GET` request every 10 minutes to:

```text
https://YOUR-RENDER-DOMAIN.onrender.com/api/cron/keep-alive
```

Render generates `CRON_SECRET` from `render.yaml`. Add it as an `x-cron-secret` request header in your cron provider. If the provider cannot send headers, use this fallback instead:

```text
https://YOUR-RENDER-DOMAIN.onrender.com/api/cron/keep-alive?key=YOUR_CRON_SECRET
```

The endpoint returns a small `200` JSON response immediately and starts a scheduler tick in the background. It is intended for cron-job.org, EasyCron, UptimeRobot, or any service that can make a recurring HTTP request.
