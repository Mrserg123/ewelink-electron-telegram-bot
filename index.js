/**
 * eWeLink Telegram Bot Template (using Telegraf)
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

const { Telegraf } = require("telegraf");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

// --- Configuration ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_NAME = process.env.BOT_NAME || "eWeLink Bot";
const EWELINK_AT = process.env.EWELINK_AT;
const EWELINK_APIKEY = process.env.EWELINK_APIKEY;
const EWELINK_REGION = process.env.EWELINK_REGION || "eu";
let botCurrency = process.env.BOT_CURRENCY || "USD";
let botKwhPrice = parseFloat(process.env.BOT_KWH_PRICE) || 0;

if (!BOT_TOKEN) {
  sendLog("error", "BOT_TOKEN is not provided. Exiting.");
  process.exit(1);
}

if (!EWELINK_AT || !EWELINK_APIKEY) {
  sendLog(
    "error",
    "eWeLink credentials (EWELINK_AT, EWELINK_APIKEY) are not provided. Exiting."
  );
  process.exit(1);
}

// --- Helpers ---

/** Send a log message to the parent Electron process */
function sendLog(level, message) {
  if (process.send) {
    process.send({
      type: "log",
      level,
      message,
      timestamp: new Date().toISOString(),
    });
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
    const response = await ewelinkRequest("GET", "/v2/device/thing?num=0");

    if (response.error === 0 && response.data && response.data.thingList) {
      return response.data.thingList
        .filter((item) => item.itemType === 1 || item.itemType === 2)
        .map((item) => item.itemData)
        .filter((device) => {
          if (!device.params) return false;
          return typeof device.params.switch !== "undefined" || 
                 typeof device.params.switches !== "undefined" ||
                 typeof device.params.state !== "undefined";
        });
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

function formatDeviceLine(device, index) {
  const name = device.name || device.deviceid;
  const online = device.online ? "🟢" : "🔴";
  let power = "";
  if (device.params) {
    if (typeof device.params.switch !== "undefined") {
      power = device.params.switch === "on" ? "⚡ ON" : "💤 OFF";
    } else if (typeof device.params.switches !== "undefined") {
      const anyOn = device.params.switches.some(s => s.switch === "on");
      power = anyOn ? "⚡ ON" : "💤 OFF";
    } else if (typeof device.params.state !== "undefined") {
      power = device.params.state === "on" ? "⚡ ON" : "💤 OFF";
    }
  }
  return `${index + 1}. ${online} *${name}*  ${power}\n\`${device.deviceid}\``;
}

function getPowerHistoryKwh(params) {
  let rawKwhData = params.hundredDaysKwhData || params.monthKwhData || params.hundredDaysKwh || params.kwhHistories || "";
  let dailyHistory = [];
  
  if (Array.isArray(rawKwhData) && rawKwhData.length > 0) {
    dailyHistory = rawKwhData.map(item => {
      const val = typeof item === "number" ? item : parseFloat(item?.kwh || item?.val || "0");
      return val > 100 ? val / 100 : val;
    });
  } else if (typeof rawKwhData === "string" && rawKwhData.length >= 2) {
    const len = rawKwhData.length;
    let step = 6;
    if (len % 6 === 0) step = 6;
    else if (len % 4 === 0) step = 4;
    else if (len % 2 === 0) step = 2;

    const maxDays = Math.min(Math.floor(len / step), 30);
    for (let i = 0; i < maxDays; i++) {
      const chunk = rawKwhData.substring(i * step, (i + 1) * step);
      const rawVal = parseInt(chunk, 16);
      if (!isNaN(rawVal)) {
        const divisor = step === 6 ? 100 : step === 4 ? (rawVal > 10000 ? 1000 : 100) : 100;
        dailyHistory.unshift(rawVal / divisor);
      }
    }
  }

  const monthTotalKwh = params.monthKwh ? parseFloat(params.monthKwh) / 100 : dailyHistory.reduce((acc, kwh) => acc + kwh, 0);
  const todayKwh = params.dayKwh ? parseFloat(params.dayKwh) / 100 : (dailyHistory[dailyHistory.length - 1] || 0);

  return {
    todayKwh: parseFloat(todayKwh.toFixed(2)),
    monthTotalKwh: parseFloat(monthTotalKwh.toFixed(2))
  };
}

// --- Bot Initialization ---
sendLog("info", `Starting ${BOT_NAME}...`);
sendLog("info", "Validating bot token...");

const bot = new Telegraf(BOT_TOKEN);

// Fetch bot info and start polling
bot.telegram.getMe().then((me) => {
    sendLog("info", `✅ Token valid! Bot: @${me.username} (${me.first_name})`);
    sendLog("info", `${BOT_NAME} is polling for messages...`);
    
    // Set bot commands for auto-completion in Telegram
    bot.telegram.setMyCommands([
      { command: "devices", description: "List all devices with status" },
      { command: "status", description: "Quick overview of all devices" },
      { command: "energy", description: "Power monitoring report" },
      { command: "help", description: "Show this message" }
    ]).catch(err => sendLog("warn", `Failed to set commands: ${err.message}`));

    if (process.send) {
        process.send({ type: "status", status: "running" });
    }
    
    bot.launch();
}).catch((err) => {
    sendLog("error", `❌ Invalid bot token: ${err.message}`);
    sendLog("error", "Please check your token from @BotFather and try again.");
    if (process.send) {
        process.send({ type: "status", status: "stopped" });
    }
    process.exit(1);
});

// --- Bot Commands ---

bot.command('start', async (ctx) => {
  const chatId = ctx.chat.id;
  sendLog("info", `/start from ${ctx.from.username || ctx.from.id}`);
  
  if (process.send) {
    process.send({ type: "chat_id", chatId });
  }
  sendLog("info", `Saved chat ID: ${chatId} for push notifications via Electron store.`);

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
    "/energy — Power monitoring report",
    "/help — Show this message",
  ].join("\n");

  await ctx.replyWithMarkdown(welcomeText);
});

bot.command('help', async (ctx) => {
  const helpText = [
    "📋 *Available Commands:*",
    "",
    "/devices — List all devices with status",
    "/on `deviceId` — Turn on a device",
    "/off `deviceId` — Turn off a device",
    "/status — Quick overview of all devices",
    "/energy — Power monitoring report",
    "/help — Show this message",
  ].join("\n");

  await ctx.replyWithMarkdown(helpText);
});

bot.command('devices', async (ctx) => {
  sendLog("info", `/devices from ${ctx.from.username || ctx.from.id}`);
  await ctx.reply("⏳ Fetching devices...");

  const devices = await fetchDevices();
  if (devices.length === 0) {
    return ctx.reply("No devices found.");
  }

  // Build inline keyboard (only for online devices)
  const inlineKeyboard = devices
    .filter((device) => device.online)
    .map((device) => {
      const name = device.name || device.deviceid;
      return [
        { text: `⚡ ${name} ON`, callback_data: `on_${device.deviceid}` },
        { text: `💤 ${name} OFF`, callback_data: `off_${device.deviceid}` },
      ];
    });

  const deviceList = devices.map(formatDeviceLine).join("\n\n");

  await ctx.replyWithMarkdown(`📱 *Your Devices:*\n\n${deviceList}`, {
    reply_markup: {
      inline_keyboard: inlineKeyboard,
    },
  });
});

bot.command('status', async (ctx) => {
  sendLog("info", `/status from ${ctx.from.username || ctx.from.id}`);
  const devices = await fetchDevices();
  
  if (devices.length === 0) {
    return ctx.reply("No devices found.");
  }

  const statusLines = devices.map(formatDeviceLine).join("\n\n");
  await ctx.replyWithMarkdown(`📊 *Device Status:*\n\n${statusLines}`);
});

bot.command('energy', async (ctx) => {
  sendLog("info", `/energy from ${ctx.from.username || ctx.from.id}`);
  await ctx.reply("⏳ Fetching energy data...");

  const devices = await fetchDevices();
  const energyDevices = devices.filter(d => d.params && (d.params.power !== undefined || d.params.hundredDaysKwhData));

  if (energyDevices.length === 0) {
    return ctx.reply("No energy monitoring devices found.");
  }

  let report = `📊 *Energy Report (${botCurrency}):*\n`;
  report += `💰 *Price:* ${botKwhPrice} ${botCurrency} per kWh\n\n`;
  for (const device of energyDevices) {
    const name = device.name || device.deviceid;
    const power = device.params.power ? (parseFloat(device.params.power) / 100).toFixed(2) + " W" : "N/A";
    const voltage = device.params.voltage ? (parseFloat(device.params.voltage) / 100).toFixed(2) + " V" : "N/A";
    const current = device.params.current ? (parseFloat(device.params.current) / 100).toFixed(2) + " A" : "N/A";
    
    const { todayKwh, monthTotalKwh } = getPowerHistoryKwh(device.params);
    const todayCost = (todayKwh * botKwhPrice).toFixed(2);
    const monthCost = (monthTotalKwh * botKwhPrice).toFixed(2);
    
    report += `⚡ *${name}*\n`;
    report += `Power: ${power}\n`;
    report += `Voltage: ${voltage} | Current: ${current}\n`;
    report += `Today: ${todayKwh} kWh (≈ ${todayCost} ${botCurrency})\n`;
    report += `This Month: ${monthTotalKwh} kWh (≈ ${monthCost} ${botCurrency})\n\n`;
  }

  await ctx.replyWithMarkdown(report);
});

bot.command('on', async (ctx) => {
  const deviceId = ctx.message.text.split(' ')[1];
  if (!deviceId) return ctx.replyWithMarkdown("Please specify device ID. Example: `/on 10001abcde`");
  
  sendLog("info", `/on ${deviceId} from ${ctx.from.username || ctx.from.id}`);
  await ctx.replyWithMarkdown(`⏳ Turning ON \`${deviceId}\`...`);

  const devices = await fetchDevices();
  const device = devices.find(d => d.deviceid === deviceId.trim());
  let params = { switch: "on" };
  if (device && device.params && device.params.switches) {
    params = { switches: device.params.switches.map(s => ({ switch: "on", outlet: s.outlet })) };
  } else if (device && device.params && (device.params.state !== undefined)) {
    params = { state: "on" };
  }

  const result = await setDeviceStatus(deviceId.trim(), params);
  if (result.error === 0) {
    await ctx.replyWithMarkdown(`✅ Device \`${deviceId}\` turned *ON*`);
  } else {
    await ctx.replyWithMarkdown(`❌ Failed to turn on \`${deviceId}\`: ${result.msg || "Unknown error"}`);
  }
});

bot.command('off', async (ctx) => {
  const deviceId = ctx.message.text.split(' ')[1];
  if (!deviceId) return ctx.replyWithMarkdown("Please specify device ID. Example: `/off 10001abcde`");
  
  sendLog("info", `/off ${deviceId} from ${ctx.from.username || ctx.from.id}`);
  await ctx.replyWithMarkdown(`⏳ Turning OFF \`${deviceId}\`...`);

  const devices = await fetchDevices();
  const device = devices.find(d => d.deviceid === deviceId.trim());
  let params = { switch: "off" };
  if (device && device.params && device.params.switches) {
    params = { switches: device.params.switches.map(s => ({ switch: "off", outlet: s.outlet })) };
  } else if (device && device.params && (device.params.state !== undefined)) {
    params = { state: "off" };
  }

  const result = await setDeviceStatus(deviceId.trim(), params);
  if (result.error === 0) {
    await ctx.replyWithMarkdown(`✅ Device \`${deviceId}\` turned *OFF*`);
  } else {
    await ctx.replyWithMarkdown(`❌ Failed to turn off \`${deviceId}\`: ${result.msg || "Unknown error"}`);
  }
});

// --- Callback Queries (Inline Buttons) ---
bot.action(/^on_(.*)$/, async (ctx) => {
  const deviceId = ctx.match[1];
  const devices = await fetchDevices();
  const device = devices.find(d => d.deviceid === deviceId);
  
  let params = { switch: "on" };
  if (device && device.params && device.params.switches) {
    params = {
      switches: device.params.switches.map(s => ({ switch: "on", outlet: s.outlet }))
    };
  } else if (device && device.params && (device.params.state !== undefined)) {
    params = { state: "on" };
  }

  await setDeviceStatus(deviceId, params);
  await ctx.answerCbQuery("Turned ON");
});

bot.action(/^off_(.*)$/, async (ctx) => {
  const deviceId = ctx.match[1];
  const devices = await fetchDevices();
  const device = devices.find(d => d.deviceid === deviceId);
  
  let params = { switch: "off" };
  if (device && device.params && device.params.switches) {
    params = {
      switches: device.params.switches.map(s => ({ switch: "off", outlet: s.outlet }))
    };
  } else if (device && device.params && (device.params.state !== undefined)) {
    params = { state: "off" };
  }

  await setDeviceStatus(deviceId, params);
  await ctx.answerCbQuery("Turned OFF");
});

// --- Error Handling ---
bot.catch((err, ctx) => {
  sendLog("error", `Bot error for ${ctx.updateType}: ${err.message}`);
});

// --- Graceful Shutdown ---
process.once("SIGINT", () => {
  sendLog("info", "Received SIGINT, stopping bot...");
  bot.stop('SIGINT');
  if (process.send) process.send({ type: "status", status: "stopped" });
  process.exit(0);
});

// --- IPC Notification Listener ---
process.on("message", async (msg) => {
  if (msg.type === "notify") {
    try {
      if (msg.chatId) {
        await bot.telegram.sendMessage(msg.chatId, msg.message, { parse_mode: "Markdown" });
      } else {
        sendLog("warn", "Cannot send notification: No chat ID configured. User must send /start to bot first.");
      }
    } catch (e) {
      sendLog("error", `Failed to send push notification: ${e.message}`);
    }
  } else if (msg.type === "config") {
    if (msg.currency) botCurrency = msg.currency;
    if (typeof msg.kwhPrice !== "undefined") botKwhPrice = parseFloat(msg.kwhPrice) || 0;
    sendLog("info", `Updated bot config via IPC. Currency: ${botCurrency}, kWh Price: ${botKwhPrice}`);
  }
});

process.once("SIGTERM", () => {
  sendLog("info", "Received SIGTERM, stopping bot...");
  bot.stop('SIGTERM');
  if (process.send) process.send({ type: "status", status: "stopped" });
  process.exit(0);
});

process.on("disconnect", () => {
  sendLog("info", "Parent process disconnected, stopping bot...");
  bot.stop();
  process.exit(0);
});
