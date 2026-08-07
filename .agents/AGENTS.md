# eWeLink Telegram Bot - Agent Knowledge Base

## Context
This repository contains a standalone Node.js script that functions as a Telegram Bot for controlling eWeLink smart home devices. 

It is designed to be bundled into a single file and executed by a parent Electron desktop application (`ewelink-react`).

## Architectural Constraints

1. **No Authentication Logic:**
   - The bot must NOT prompt the user for an eWeLink email/password.
   - The parent Electron application handles eWeLink authentication. It passes the authenticated session tokens to the bot via environment variables (`EWELINK_AT`, `EWELINK_APIKEY`, `EWELINK_REGION`).
   - The bot initializes the `ewelink-api` using these provided tokens.

2. **Single File Build Requirement:**
   - The bot is compiled into a single file (`dist/index.js`) using `@vercel/ncc`.
   - All code, assets, and dependencies must be compatible with being bundled into a single CommonJS file.
   - Avoid reading files from the filesystem using relative paths (e.g., `fs.readFileSync('./data.json')`), because the bot will be executed from the user's `%APPDATA%` directory, not the repository folder.
   - Any persistent data must be saved to the absolute path where the bot is executed from (e.g., use `process.cwd()` or expect a path passed via environment variables), or handled via IPC back to the main Electron app.

3. **IPC Communication:**
   - The bot uses standard Node.js Inter-Process Communication (IPC) via `process.send()`.
   - Always wrap `process.send()` in a check for `process.send` to prevent crashing if the bot is run standalone for testing:
     ```javascript
     if (process.send) {
       process.send({ type: "log", level: "info", message: "Bot started" });
     } else {
       console.log("Bot started");
     }
     ```

4. **GitHub Actions:**
   - Deployments are fully automated.
   - Modifying `.github/workflows/release.yml` should be done with care to ensure `bot-bundle.js` is correctly built and attached to the GitHub release.

## Tech Stack
- **API Wrapper:** `ewelink-api`
- **Telegram Wrapper:** `node-telegram-bot-api`
- **Bundler:** `@vercel/ncc`
