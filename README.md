# eWeLink Telegram Bot

This is a standalone Telegram bot designed to be dynamically downloaded and executed by the [eWeLink Desktop V2](https://github.com/Mrserg123/ewelink-react) application. 

The bot provides real-time control over eWeLink smart home devices through Telegram commands and inline keyboards.

## Architecture

This bot runs as a separate Node.js process using `child_process.fork()` initiated by the main Electron application. 

**It does not handle its own authentication**. Instead, it relies on the parent Electron application to pass the authenticated session tokens via environment variables.

### Environment Variables
The bot requires the following environment variables to run:
- `BOT_TOKEN`: The Telegram Bot API token (from @BotFather).
- `BOT_NAME`: Display name for the bot (optional, defaults to "eWeLink Bot").
- `EWELINK_AT`: The eWeLink Access Token.
- `EWELINK_APIKEY`: The eWeLink User API Key.
- `EWELINK_REGION`: The user's region (e.g., `eu`, `us`, `as`, `cn`).

### IPC Communication
The bot communicates with the parent Electron application using `process.send()`.
- **Logs:** `{ type: "log", level: "info" | "error", message: string, timestamp: string }`
- **Status:** `{ type: "status", status: "running" | "stopped" }`

## Development & Building

The project uses `@vercel/ncc` to compile the entire bot and its dependencies (like `node-telegram-bot-api`) into a single file (`dist/index.js`). This makes it easy for the Electron application to download and run the bot without needing to run `npm install` on the end-user's machine.

1. Install dependencies: `npm install`
2. Build the project: `npm run build`

## Release Process

Releases are fully automated using GitHub Actions. 
Whenever a new release is drafted on GitHub with a tag starting with `v` (e.g., `v1.0.2`), the `.github/workflows/release.yml` action will:
1. Compile the code using `npm run build`.
2. Rename `dist/index.js` to `bot-bundle.js`.
3. Attach `bot-bundle.js` as a release asset.

The main Electron application is hardcoded to always download the `latest` release asset named `bot-bundle.js`.
