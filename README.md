# Finance Project

Frontend: React (Vite) + Tailwind CSS + JSpreadsheet CE
Backend: Firebase Cloud Functions + Firestore

Quick start

1. Install Node.js (v18+) and npm.

2. Install frontend deps:

```bash
cd web
npm install
```

3. Install functions deps:

```bash
cd ../functions
npm install
```

4. Start frontend dev server:

```bash
cd ../web
npm run dev
```

5. To develop functions locally, install and login to Firebase CLI and start the emulator:

```bash
npm install -g firebase-tools
firebase login
cd functions
npm run serve
```

6. When ready, deploy functions:

```bash
firebase deploy --only functions
```

Notes

- `jspreadsheet-ce` is included as the spreadsheet UI. If you prefer a different version, adjust `web/package.json`.
- Add your Firebase project with `firebase init` in the repo root and enable `functions` and `firestore`.
