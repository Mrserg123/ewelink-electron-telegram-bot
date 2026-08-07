/**
 * eWeLink Telegram Bot Template
 *
 * Receives configuration via environment variables:
 *   BOT_TOKEN       — Telegram bot token from @BotFather
 *   BOT_NAME        — Display name for the bot
 *   EWELINK_AT      — eWeLink access token
 *   EWELINK_APIKEY  — eWeLink user API key
 *   EWELINK_REGION  — eWeLink region (eu, us, as, cn)
 *
 * Communicates with the parent Electron process via process.send().
 */

const TelegramBot = require("node-telegram-bot-api");
const https = require("https");
const http = require("http");

// --- Configuration ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_NAME = process.env.BOT_NAME || "eWeLink Bot";
const EWELINK_AT = process.env.EWELINK_AT;
const EWELINK_APIKEY = process.env.EWELINK_APIKEY;
const EWELINK_REGION = process.env.EWELINK_REGION || "eu";

if (!BOT_TOKEN) {
  sendLog("error", "BOT_TOKEN is not provided. Exiting.");
  process.exit(1);
}

if (!EWELINK_AT || !EWELINK_APIKEY) {
  sendLog(
    "error",
    "eWeLink credentials (EWELINK_AT, EWELINK_APIKEY) are not provided. Exiting.",
  );
  process.exit(1);
}

// --- Helpers ---

/** Send a log message to the parent Electron process */
function sendLog(level, message) {
  if (process.send) {
    process.send({ type: "log", level, message, timestamp: new Date().toISOString() });
  }
  console.log(`[${level.toUpperCase()}] ${message}`);
}

/** Get eWeLink API base URL for the configured region */
function getApiBase() {
  if (EWELINK_REGION === "cn") {
    return "https://cn-apia.coolkit.cn";
  }
  return `https://${EWELINK_REGION}-apia.coolkit.cc`;
}

/**
 * Make an HTTP request to the eWeLink API.
 * @param {string} method - HTTP method
 * @param {string} path - API path (e.g., "/v2/device/thing")
 * @param {object|null} body - Request body for POST/PUT
 * @returns {Promise<object>} Parsed JSON response
 */
function ewelinkRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const base = getApiBase();
    const url = new URL(path, base);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;

    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: method.toUpperCase(),
      headers: {
        Authorization: `Bearer ${EWELINK_AT}`,
        "Content-Type": "application/json",
        "X-CK-Appid": "Uw83EKZFxdif7XFXEsrpduz5YyjP7nTl",
      },
    };

    if (payload) {
      options.headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on("error", reject);

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

/** Fetch the list of devices (things) from eWeLink */
async function fetchDevices() {
  try {
    const response = await ewelinkRequest("POST", "/v2/device/thing", {
      thingList: [],
    });

    if (response.error === 0 && response.data && response.data.thingList) {
      // Filter only physical devices (itemType 1 or 2), skip groups (3)
      return response.data.thingList
        .filter((item) => item.itemType === 1 || item.itemType === 2)
        .map((item) => item.itemData);
    }

    sendLog("warn", `fetchDevices API error: ${JSON.stringify(response)}`);
    return [];
  } catch (err) {
    sendLog("error", `fetchDevices failed: ${err.message}`);
    return [];
  }
}

/** Set device power state */
async function setDeviceStatus(deviceId, params) {
  try {
    const response = await ewelinkRequest("POST", "/v2/device/thing/status", {
      type: 1,
      id: deviceId,
      params,
    });

    return response;
  } catch (err) {
    sendLog("error", `setDeviceStatus failed for ${deviceId}: ${err.message}`);
    return { error: -1, msg: err.message };
  }
}

/**
 * Format device name + online status for display
 */
function formatDeviceLine(device, index) {
  const name = device.name || device.deviceid;
  const online = device.online ? "🟢" : "🔴";
  const power =
    device.params && device.params.switch
      ? device.params.switch === "on"
        ? "⚡ ON"
        : "💤 OFF"
      : "";
  return `${index + 1}. ${online} *${name}*  ${power}\n\`${device.deviceid}\``;
}

// --- Bot Initialization ---

sendLog("info", `Starting ${BOT_NAME}...`);
sendLog("info", "Validating bot token...");

// Initialize the bot with polling immediately to ensure event handlers bind correctly.
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let pollingErrorCount = 0;
const MAX_POLLING_ERRORS = 5;

// We still fetch getMe to display the bot name and verify the token.
(async () => {
  try {
    const me = await bot.getMe();
    sendLog("info", `✅ Token valid! Bot: @${me.username} (${me.first_name})`);
    sendLog("info", `${BOT_NAME} is polling for messages...`);

    // Notify parent process that bot is running
    if (process.send) {
      process.send({ type: "status", status: "running" });
    }
  } catch (err) {
    sendLog("error", `❌ Invalid bot token: ${err.message}`);
    sendLog("error", "Please check your token from @BotFather and try again.");
    bot.stopPolling();
    if (process.send) {
      process.send({ type: "status", status: "stopped" });
    }
    process.exit(1);
  }
})();

// --- Bot Commands ---

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  sendLog("info", `/start from ${msg.from.username || msg.from.id}`);

  const welcomeText = [
    `👋 *Welcome to ${BOT_NAME}!*`,
    "",
    "I can help you control your eWeLink smart devices.",
    "",
    "📋 *Commands:*",
    "/devices — List all devices",
    "/on `deviceId` — Turn on a device",
    "/off `deviceId` — Turn off a device",
    "/status — Quick status of all devices",
    "/help — Show this message",
  ].join("\n");

  bot.sendMessage(chatId, welcomeText, { parse_mode: "Markdown" });
});

bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;

  const helpText = [
    "📋 *Available Commands:*",
    "",
    "/devices — List all devices with status",
    "/on `deviceId` — Turn on a device",
    "/off `deviceId` — Turn off a device",
    "/status — Quick overview of all devices",
    "/help — Show this message",
  ].join("\n");

  bot.sendMessage(chatId, helpText, { parse_mode: "Markdown" });
});

bot.onText(/\/devices/, async (msg) => {
  const chatId = msg.chat.id;
  sendLog("info", `/devices from ${msg.from.username || msg.from.id}`);

  bot.sendMessage(chatId, "⏳ Fetching devices...");

  const devices = await fetchDevices();

  if (devices.length === 0) {
    bot.sendMessage(chatId, "No devices found.");
    return;
  }

  // Build inline keyboard with ON/OFF buttons for each device
  const inlineKeyboard = devices.map((device) => {
    const name = device.name || device.deviceid;
    return [
      {
        text: `⚡ ${name} ON`,
        callback_data: `on_${device.deviceid}`,
      },
      {
        text: `💤 ${name} OFF`,
        callback_data: `off_${device.deviceid}`,
      },
    ];
  });

  const deviceList = devices.map(formatDeviceLine).join("\n\n");

  bot.sendMessage(chatId, `📱 *Your Devices:*\n\n${deviceList}`, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: inlineKeyboard,
    },
  });
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  sendLog("info", `/status from ${msg.from.username || msg.from.id}`);

  const devices = await fetchDevices();

  if (devices.length === 0) {
    bot.sendMessage(chatId, "No devices found.");
    return;
  }

  const statusLines = devices.map(formatDeviceLine).join("\n\n");

  bot.sendMessage(chatId, `📊 *Device Status:*\n\n${statusLines}`, {
    parse_mode: "Markdown",
  });
});

bot.onText(/\/on\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const deviceId = match[1].trim();
  sendLog("info", `/on ${deviceId} from ${msg.from.username || msg.from.id}`);

  bot.sendMessage(chatId, `⏳ Turning ON \`${deviceId}\`...`, {
    parse_mode: "Markdown",
  });

  const result = await setDeviceStatus(deviceId, { switch: "on" });

  if (result.error === 0) {
    bot.sendMessage(chatId, `✅ Device \`${deviceId}\` turned *ON*`, {
      parse_mode: "Markdown",
    });
  } else {
    bot.sendMessage(
      chatId,
      `❌ Failed to turn on \`${deviceId}\`: ${result.msg || "Unknown error"}`,
      { parse_mode: "Markdown" },
    );
  }
});

bot.onText(/\/off\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const deviceId = match[1].trim();
  sendLog("info", `/off ${deviceId} from ${msg.from.username || msg.from.id}`);

  bot.sendMessage(chatId, `⏳ Turning OFF \`${deviceId}\`...`, {
    parse_mode: "Markdown",
  });

  const result = await setDeviceStatus(deviceId, { switch: "off" });

  if (result.error === 0) {
    bot.sendMessage(chatId, `✅ Device \`${deviceId}\` turned *OFF*`, {
      parse_mode: "Markdown",
    });
  } else {
    bot.sendMessage(
      chatId,
      `❌ Failed to turn off \`${deviceId}\`: ${result.msg || "Unknown error"}`,
      { parse_mode: "Markdown" },
    );
  }
});

// --- Callback Query Handler (inline keyboard buttons) ---

bot.on("callback_query", async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  const [action, deviceId] = data.split("_");

  if (!deviceId) {
    bot.answerCallbackQuery(callbackQuery.id, { text: "Unknown action" });
    return;
  }

  const params = { switch: action === "on" ? "on" : "off" };
  const emoji = action === "on" ? "⚡" : "💤";

  sendLog("info", `Callback: ${action} ${deviceId}`);

  bot.answerCallbackQuery(callbackQuery.id, {
    text: `${emoji} ${action.toUpperCase()} ${deviceId}...`,
  });

  const result = await setDeviceStatus(deviceId, params);

  if (result.error === 0) {
    bot.sendMessage(
      chatId,
      `✅ Device \`${deviceId}\` turned *${action.toUpperCase()}*`,
      { parse_mode: "Markdown" },
    );
  } else {
    bot.sendMessage(
      chatId,
      `❌ Failed: ${result.msg || "Unknown error"}`,
      { parse_mode: "Markdown" },
    );
  }
});

// --- Error Handling ---

bot.on("polling_error", (err) => {
  pollingErrorCount++;
  sendLog("error", `Polling error (${pollingErrorCount}/${MAX_POLLING_ERRORS}): ${err.message}`);

  // Auto-stop on repeated errors (e.g. invalid token, network down)
  if (pollingErrorCount >= MAX_POLLING_ERRORS) {
    sendLog("error", `Too many polling errors (${MAX_POLLING_ERRORS}). Stopping bot...`);
    bot.stopPolling();
    if (process.send) {
      process.send({ type: "status", status: "stopped" });
    }
    process.exit(1);
  }
});

bot.on("error", (err) => {
  sendLog("error", `Bot error: ${err.message}`);
});

// Reset error counter on successful message receipt
bot.on("message", () => {
  pollingErrorCount = 0;
});

// --- Graceful Shutdown ---

process.on("SIGTERM", () => {
  sendLog("info", "Received SIGTERM, stopping bot...");
  bot.stopPolling();
  if (process.send) {
    process.send({ type: "status", status: "stopped" });
  }
  process.exit(0);
});

process.on("SIGINT", () => {
  sendLog("info", "Received SIGINT, stopping bot...");
  bot.stopPolling();
  if (process.send) {
    process.send({ type: "status", status: "stopped" });
  }
  process.exit(0);
});

// Handle parent disconnect (Electron closed)
process.on("disconnect", () => {
  sendLog("info", "Parent process disconnected, stopping bot...");
  bot.stopPolling();
  process.exit(0);
});
