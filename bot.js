require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");

const BOT_TOKEN = process.env.SUPPORT_BOT_TOKEN;
const ADMIN_ID = String(process.env.SUPPORT_ADMIN_ID || "").trim();
const WA_CHANNEL_URL = (
  process.env.WHATSAPP_CHANNEL_URL ||
  "https://whatsapp.com/channel/0029Vb8ju67LI8Yesr2COa0P"
).trim();

if (!BOT_TOKEN || !ADMIN_ID) {
  console.error("❌ تأكد من وجود SUPPORT_BOT_TOKEN و SUPPORT_ADMIN_ID في ملف .env");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// حماية شاملة من أي خطأ غير متوقع حتى لا يخرج البوت
bot.catch((err, ctx) => {
  console.error(`[BOT-CATCH] update=${ctx?.update?.update_id}:`, err?.message || err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED-REJECTION]", reason?.message || reason);
});

process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT-EXCEPTION]", err?.message || err);
});

const ticketMap = new Map();
const usersSet = new Set();
const userGateState = new Map();
let totalTickets = 0;
let activeReplyTarget = null;

function safeAnswer(ctx, text, extra = {}) {
  if (!ctx || typeof ctx.answerCbQuery !== "function") return Promise.resolve();
  return ctx.answerCbQuery(text, extra).catch(() => {});
}

// استخراج بيانات المرسل من نص الرسالة المحوّلة كخطة بديلة إذا أُعيد تشغيل البوت
function extractTargetFromMessage(msg) {
  if (!msg) return null;
  const body = msg.text || msg.caption || "";
  const idMatch = body.match(/ID:\s*(\d+)/i);
  if (!idMatch) return null;

  const nameMatch = body.match(/الاسم:\s*([^\n]+)/);
  const rawName = (nameMatch?.[1] || "").trim();
  const cleanName = rawName && rawName !== "." ? rawName : `مستخدم (${idMatch[1]})`;

  return {
    userId: String(idMatch[1]),
    userName: cleanName
  };
}

function getGateState(userId) {
  return userGateState.get(userId) || "unverified";
}

function getVerifiedCount() {
  let count = 0;
  for (const state of userGateState.values()) {
    if (state === "verified") count += 1;
  }
  return count;
}

function adminKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("📊 الإحصائيات", "admin_stats"),
      Markup.button.callback("🔄 تحديث", "admin_refresh")
    ]
  ]);
}

function waGateKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.url("📢 متابعة قناة عبود تك في واتساب", WA_CHANNEL_URL)],
    [Markup.button.callback("✔️ لقد تابعت القناة", "wa_step1_done")]
  ]);
}

function waStep2Keyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.url("🔗 فتح القناة مرة أخرى", WA_CHANNEL_URL)],
    [Markup.button.callback("✅ أؤكد أنني تابعت القناة فعلاً", "wa_step2_confirm")],
    [Markup.button.callback("🔙 رجوع", "wa_back_step1")]
  ]);
}

async function sendWaGateMessage(ctx, edit = false) {
  const text =
    `⚠️ *عذراً، خدمة الدعم الفني — عبود تك*\n\n` +
    `لفتح إرسال رسائل الدعم، يجب أولاً **متابعة قناة عبود تك (Abood Tech) في واتساب**.\n\n` +
    `1️⃣ اضغط على *متابعة قناة عبود تك في واتساب*.\n` +
    `2️⃣ بعد الاشتراك في القناة، اضغط *لقد تابعت القناة*.`;

  if (edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        ...waGateKeyboard()
      });
      return;
    } catch (_) {}
  }

  await ctx.reply(text, {
    parse_mode: "Markdown",
    ...waGateKeyboard()
  }).catch(() => {});
}

async function sendWaStep2Message(ctx, edit = false) {
  const text =
    `🔐 *تأكيد متابعة القناة — الخطوة الثانية*\n\n` +
    `*(ملاحظة: لا يمكن التحقق آلياً من واتساب داخل تيليجرام، لذا نعتمد على تأكيدك)*\n\n` +
    `هل قمت فعلاً بمتابعة قناة **عبود تك** على الرابط:\n` +
    `${WA_CHANNEL_URL}\n\n` +
    `اضغط *أؤكد أنني تابعت القناة فعلاً* لفتح الدعم.`;

  if (edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        ...waStep2Keyboard()
      });
      return;
    } catch (_) {}
  }

  await ctx.reply(text, {
    parse_mode: "Markdown",
    ...waStep2Keyboard()
  }).catch(() => {});
}

async function sendStatsMessage(ctx, editMessage = false) {
  const text =
    `📊 *إحصائيات بوت الدعم — عبود تك*\n\n` +
    `👥 إجمالي المستخدمين: *${usersSet.size}*\n` +
    `✅ المؤكدون لمتابعة الواتساب: *${getVerifiedCount()}*\n` +
    `📩 إجمالي الرسائل المستلمة: *${totalTickets}*\n` +
    `🎯 وضع الرد الحالي: *${
      activeReplyTarget
        ? `${activeReplyTarget.userName} (${activeReplyTarget.userId})`
        : "غير مفعّل"
    }*`;

  if (editMessage && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        ...adminKeyboard()
      });
      return;
    } catch (_) {}
  }

  await ctx.reply(text, {
    parse_mode: "Markdown",
    ...adminKeyboard()
  }).catch(() => {});
}

bot.start(async (ctx) => {
  const chatId = String(ctx.chat.id);
  const firstName = ctx.from?.first_name || "صديقنا";

  if (chatId === ADMIN_ID) {
    activeReplyTarget = null;
    return ctx.reply(
      `🛠️ *لوحة إدارة الدعم — عبود تك*\n\n` +
        `البوت متصل ويعمل بنجاح.\n` +
        `• اضغط زر *✉️ رد على المرسل* أسفل أي رسالة دعم، أو اعمل *Reply* عليها.\n` +
        `• اضغط زر *📊 الإحصائيات* أو أرسل /stats لعرض الأرقام.`,
      {
        parse_mode: "Markdown",
        ...adminKeyboard()
      }
    ).catch(() => {});
  }

  usersSet.add(chatId);
  const state = getGateState(chatId);

  if (state === "pending_step2") {
    return sendWaStep2Message(ctx, false);
  }

  if (state !== "verified") {
    return sendWaGateMessage(ctx, false);
  }

  await ctx.reply(
    `👋 أهلاً بك مجدداً يا *${firstName}* في **خدمة الدعم الفني — عبود تك**!\n\n` +
      `📩 اكتب رسالتك أو استفسارك أو أرسل صورة/ملفاً هنا، وسيتم تحويلها مباشرة إلى فريق الدعم.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📌 طريقة التواصل", "how_to_use")]
      ])
    }
  ).catch(() => {});
});

bot.action("wa_step1_done", async (ctx) => {
  const chatId = String(ctx.chat.id);
  usersSet.add(chatId);
  userGateState.set(chatId, "pending_step2");
  await safeAnswer(ctx, "الخطوة 2: أكّد متابعتك للقناة");
  await sendWaStep2Message(ctx, true);
});

bot.action("wa_back_step1", async (ctx) => {
  const chatId = String(ctx.chat.id);
  usersSet.add(chatId);
  userGateState.set(chatId, "unverified");
  await safeAnswer(ctx);
  await sendWaGateMessage(ctx, true);
});

bot.action("wa_step2_confirm", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const firstName = ctx.from?.first_name || "صديقنا";

  usersSet.add(chatId);
  userGateState.set(chatId, "verified");

  await safeAnswer(ctx, "✅ تم فتح الدعم الفني");

  await ctx.reply(
    `🎉 أهلاً بك يا *${firstName}* في **خدمة الدعم الفني — عبود تك**!\n\n` +
      `تم فتح إرسال الرسائل لك. اكتب رسالتك أو أرسل صورة/ملفاً الآن وسنقوم بالرد عليك.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📌 طريقة التواصل", "how_to_use")]
      ])
    }
  ).catch(() => {});
});

bot.action("how_to_use", async (ctx) => {
  await safeAnswer(ctx);
  await ctx.reply(
    "📝 *طريقة إرسال طلب دعم:*\n" +
      "1️⃣ تابع قناة عبود تك (Abood Tech) في واتساب وأكّد المتابعة.\n" +
      "2️⃣ اكتب تفاصيل طلبك في رسالة واضحة أو أرفق صورة/ملفاً.\n" +
      "3️⃣ انتظر رد الإدارة في نفس هذه المحادثة.",
    { parse_mode: "Markdown" }
  ).catch(() => {});
});

bot.action("admin_stats", async (ctx) => {
  if (String(ctx.chat.id) !== ADMIN_ID) {
    return safeAnswer(ctx, "غير مصرح", { show_alert: true });
  }
  await safeAnswer(ctx, "📊 تم جلب الإحصائيات");
  await sendStatsMessage(ctx, false);
});

bot.action("admin_refresh", async (ctx) => {
  if (String(ctx.chat.id) !== ADMIN_ID) {
    return safeAnswer(ctx, "غير مصرح", { show_alert: true });
  }
  await safeAnswer(ctx, "🔄 تم التحديث");
  await sendStatsMessage(ctx, true);
});

bot.action(/^reply_ticket:(\d+)$/, async (ctx) => {
  if (String(ctx.chat.id) !== ADMIN_ID) {
    return safeAnswer(ctx, "هذا الزر مخصص للإدارة فقط", { show_alert: true });
  }

  const msgId = Number(ctx.match[1]);
  let target = ticketMap.get(msgId);

  if (!target) {
    target = extractTargetFromMessage(ctx.callbackQuery?.message);
    if (target) {
      ticketMap.set(msgId, target);
    }
  }

  if (!target) {
    await safeAnswer(ctx, "⚠️ تعذر تحديد بيانات المرسل من هذه الرسالة", { show_alert: true });
    return;
  }

  activeReplyTarget = target;
  await safeAnswer(ctx, `✉️ جاهز للرد على ${target.userName}`);

  await ctx.reply(
    `✍️ *تم تحديد المستلم للرد:*\n` +
      `👤 الاسم: *${target.userName}*\n` +
      `🆔 المعرف: \`${target.userId}\`\n\n` +
      `اكتب الآن رسالتك أو أرسل صورة/ملفاً ليتم إرساله له مباشرة، أو أرسل /cancel للإلغاء.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("❌ إلغاء وضع الرد", "cancel_reply")]
      ])
    }
  ).catch(() => {});
});

bot.action("cancel_reply", async (ctx) => {
  if (String(ctx.chat.id) !== ADMIN_ID) return safeAnswer(ctx);
  activeReplyTarget = null;
  await safeAnswer(ctx, "تم الإلغاء");
  await ctx.reply("✅ تم إلغاء وضع الرد المباشر.").catch(() => {});
});

bot.command("stats", async (ctx) => {
  if (String(ctx.chat.id) !== ADMIN_ID) return;
  await sendStatsMessage(ctx, false);
});

bot.command("cancel", async (ctx) => {
  if (String(ctx.chat.id) !== ADMIN_ID) return;
  activeReplyTarget = null;
  await ctx.reply("✅ تم إلغاء وضع الرد المباشر.").catch(() => {});
});

async function deliverAdminReply(ctx, targetUserId) {
  if (ctx.message.text) {
    await bot.telegram.sendMessage(
      targetUserId,
      `💬 *رد فريق الدعم — عبود تك:*\n\n${ctx.message.text}`,
      { parse_mode: "Markdown" }
    );
  } else if (ctx.message.photo) {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    await bot.telegram.sendPhoto(targetUserId, photo.file_id, {
      caption: ctx.message.caption
        ? `💬 *رد فريق الدعم — عبود تك:*\n\n${ctx.message.caption}`
        : "💬 *رد فريق الدعم — عبود تك:*",
      parse_mode: "Markdown"
    });
  } else {
    await bot.telegram.copyMessage(targetUserId, ctx.chat.id, ctx.message.message_id);
  }
}

bot.on("message", async (ctx) => {
  const chatId = String(ctx.chat.id);

  if (chatId === ADMIN_ID) {
    let targetUserId = null;
    let targetLabel = "";

    if (ctx.message.reply_to_message) {
      const repliedId = ctx.message.reply_to_message.message_id;
      let found = ticketMap.get(repliedId);
      if (!found) {
        found = extractTargetFromMessage(ctx.message.reply_to_message);
      }
      if (found) {
        targetUserId = found.userId;
        targetLabel = found.userName;
      }
    }

    if (!targetUserId && activeReplyTarget) {
      targetUserId = activeReplyTarget.userId;
      targetLabel = activeReplyTarget.userName;
    }

    if (!targetUserId) {
      return ctx.reply(
        "ℹ️ للرد على مستخدم: اضغط زر *✉️ رد على المرسل* أسفل رسالته، أو اعمل *Reply* عليها.",
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }

    try {
      await deliverAdminReply(ctx, targetUserId);
      const sentName = targetLabel || targetUserId;
      activeReplyTarget = null;
      return ctx.reply(`✅ تم إرسال ردك إلى *${sentName}* بنجاح.`, {
        parse_mode: "Markdown",
        ...adminKeyboard()
      }).catch(() => {});
    } catch (err) {
      console.error("[REPLY-ERR]", err?.message || err);
      return ctx.reply("❌ فشل إرسال الرد (قد يكون المستخدم حظر البوت).").catch(() => {});
    }
  }

  usersSet.add(chatId);
  const state = getGateState(chatId);

  if (state === "pending_step2") {
    return sendWaStep2Message(ctx, false);
  }

  if (state !== "verified") {
    return sendWaGateMessage(ctx, false);
  }

  totalTickets += 1;

  const rawFullName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ").trim();
  const fullName = rawFullName && rawFullName !== "." ? rawFullName : `مستخدم (${chatId})`;
  const username = ctx.from?.username ? `@${ctx.from.username}` : "بدون معرف";

  const header =
    `📩 *رسالة دعم جديدة (#${totalTickets})*\n` +
    `👤 *الاسم:* ${fullName}\n` +
    `🔗 *المعرف:* ${username}\n` +
    `🆔 *ID:* \`${chatId}\`\n` +
    `📢 *تأكيد متابعة واتساب:* مؤكد يدوياً\n` +
    `━━━━━━━━━━━━━━\n`;

  try {
    let sentToAdmin;

    if (ctx.message.text) {
      sentToAdmin = await bot.telegram.sendMessage(
        ADMIN_ID,
        `${header}${ctx.message.text}`,
        { parse_mode: "Markdown" }
      );
    } else if (ctx.message.photo) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      sentToAdmin = await bot.telegram.sendPhoto(ADMIN_ID, photo.file_id, {
        caption: `${header}${ctx.message.caption || "🖼️ صورة مرفقة"}`,
        parse_mode: "Markdown"
      });
    } else {
      sentToAdmin = await bot.telegram.sendMessage(
        ADMIN_ID,
        `${header}📎 [مرفق من المستخدم بالأسفل]`,
        { parse_mode: "Markdown" }
      );
      const copied = await bot.telegram.copyMessage(ADMIN_ID, chatId, ctx.message.message_id);
      if (copied?.message_id) {
        ticketMap.set(copied.message_id, {
          userId: chatId,
          userName: fullName,
          ticketNum: totalTickets
        });
      }
    }

    if (sentToAdmin?.message_id) {
      const ticketInfo = {
        userId: chatId,
        userName: fullName,
        ticketNum: totalTickets
      };
      ticketMap.set(sentToAdmin.message_id, ticketInfo);

      await bot.telegram.editMessageReplyMarkup(
        ADMIN_ID,
        sentToAdmin.message_id,
        undefined,
        Markup.inlineKeyboard([
          [Markup.button.callback(`✉️ رد على ${fullName}`, `reply_ticket:${sentToAdmin.message_id}`)]
        ]).reply_markup
      ).catch(() => {});
    }

    await ctx.reply("✅ تم استلام رسالتك بنجاح، سيتواصل معك فريق الدعم قريباً.").catch(() => {});
  } catch (err) {
    console.error("[FORWARD-ERR]", err?.message || err);
    await ctx.reply("⚠️ حدث خطأ مؤقت أثناء إرسال رسالتك، حاول مرة أخرى.").catch(() => {});
  }
});

bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log("🚀 بوت الدعم (عبود تك) يعمل الآن بنجاح...");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
