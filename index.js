// 必要なパッケージのインポート
const express = require("express");
const line = require("@line/bot-sdk");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

// Bot設定・メッセージ
const BOT_CONFIG = {
  commands: {
    setWakeupTime: /(\d{1,2})(?::|(時))(\d{0,2})に起きる/,
    goodSleep: ["ぐっすり", "明日パス", "明日休み"],
    goodSleepCancel: ["ぐっすり取消", "ぐっすり取り消し", "ぐっすりキャンセル"],
    recordCheck: ["記録確認", "記録"],
    settingsCheck: ["設定確認", "設定"],
    help: ["使い方", "ヘルプ", "help"],
    wakeupKeywords: ["起きた", "起床", "おはよう", "朝"],
  },
  messages: {
    wakeupSuccess: "{userName}さん、起床報告を記録しました✔️",
    wakeupAlreadyReported: "今日はすでに起床報告済みです！",
    timeSetSuccess: "OK！{hours}:{minutes}に設定しました⏰",
    timeFormatError:
      "時間の形式が正しくありません。例: 7時に起きる または 7:00に起きる",
    noTimeSet:
      "起床時間が設定されていません。\n7時に起きる で設定してください。",
    goodSleepSuccess:
      "{userName}さん、明日の早起きはパスします。ゆっくりぐっすり眠ってください😴\n（週に1回のぐっすり機能を使用しました）",
    goodSleepTimeLimit: "ぐっすり機能は22時までに宣言する必要があります。",
    goodSleepWeeklyLimit: "ぐっすり機能は週に1回しか使用できません。",
    goodSleepCancelSuccess:
      "{userName}さん、ぐっすり機能の使用を取り消しました。明日の早起きは通常通り必要です。",
    goodSleepNotUsed: "ぐっすり機能を使用していないため、取り消しできません。",
    allSuccess: "全員が時間通りに起きました！連続記録は{streak}日目です🎉",
    someoneFailure:
      "⚠️ {failedUsers}さんが寝坊しました…連続記録はリセットされます💀\n（{oldStreak}日でした）",
    helpText: `起きるくんneo使い方ガイド 

📱 基本コマンド
・「7時に起きる」「6:30に起きる」
→ 起床時間を設定 

・ 「起きた」「起床」「おはよう」「朝」
→ 起床報告 

・ 「ぐっすり」「明日パス」「明日休み」
→ 翌日の早起きをパス（週1回まで）

・ 「記録確認」
→ 連続記録・最高記録を確認

・ 「設定確認」「設定」
→ 自分の起床時間を確認 

・ 「使い方」「ヘルプ」「help」→ コマンド一覧、ヘルプを表示


🔄 使い方の流れ
起床時間を設定（例：「7時に起きる」）
↓
 翌日設定時間までに起床報告（例：「おはよう！」） 
↓
12:00に結果集計→全員成功でチャレンジ達成。連続記録を目指そう！

😴 ぐっすり機能（特別パス）
使用条件：22:00より前に宣言必須 
使用回数：週に1回まで 
取り消し：「ぐっすり取消」で取消可能

📊 集計について
・毎日正午に自動集計 
・全員成功→連続記録UP
・誰か失敗→連続記録リセット

⚠️ 注意点
・起床報告は設定時間より前に必要 
・同じ日の起床報告は1回まで 
・起床時間未設定は集計対象外
`,
    recordStatus: "現在の連続記録: {streak}日\n最高連続記録: {best}日",
    userSettings: "{userName}さんの起床時間: {hours}:{minutes}",
    unknownCommand:
      "コマンドが認識できませんでした。\n「使い方」でヘルプを表示します。",
    testAggregation: "テスト用に集計を実行しました。",
    testTimeSet: "テスト用時間を{hours}:{minutes}に設定しました。",
  },
};

// 設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// データ保存用のパス
const dataFilePath = "./.data/bot-data.json";

// データの初期化
let botData = {
  users: {}, // ユーザー情報を格納
  groups: {}, // グループ情報を格納
  streakRecord: 0, // 最高連続記録
  currentStreak: 0, // 現在の連続記録
};

// フォルダが存在しない場合は作成
if (!fs.existsSync("./.data")) {
  fs.mkdirSync("./.data");
}

// データファイルが存在する場合は読み込む
if (fs.existsSync(dataFilePath)) {
  try {
    botData = JSON.parse(fs.readFileSync(dataFilePath, "utf8"));
  } catch (error) {
    console.error("データ読み込みエラー:", error);
  }
}

// テスト用の時間設定関数を追加
function setTestTime(hours, minutes) {
  const testDate = new Date();
  testDate.setHours(hours, minutes, 0, 0);
  return testDate;
}

// データを保存する関数
function saveData() {
  try {
    fs.writeFileSync(dataFilePath, JSON.stringify(botData, null, 2));
  } catch (error) {
    console.error("データ保存エラー:", error);
  }
}

const app = express();

// LINE SDKの設定
const client = new line.Client(config);

// Webhookルート
app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// イベントハンドラ
async function handleEvent(event) {
  // メッセージイベント以外は無視
  if (event.type !== "message" || event.message.type !== "text") {
    return Promise.resolve(null);
  }

  const userId = event.source.userId;
  const groupId = event.source.groupId || event.source.roomId;
  const text = event.message.text;

  // ユーザー名を取得
  let userName = "ユーザー";
  try {
    let profile;
    if (event.source.type === "group") {
      profile = await client.getGroupMemberProfile(groupId, userId);
    } else if (event.source.type === "room") {
      profile = await client.getRoomMemberProfile(groupId, userId);
    } else {
      profile = await client.getProfile(userId);
    }
    userName = profile.displayName;
  } catch (error) {
    console.error("プロフィール取得エラー:", error);
  }

  // グループが初めての場合は初期化
  if (groupId && !botData.groups[groupId]) {
    botData.groups[groupId] = {
      users: {},
      currentStreak: 0,
      bestStreak: 0,
    };
  }

  // ユーザーが初めての場合は初期化
  if (groupId && !botData.groups[groupId].users[userId]) {
    botData.groups[groupId].users[userId] = {
      name: userName,
      wakeupTime: null,
      lastReport: null,
      todayReported: false,
      jokerUsed: false,
      lastJokerDate: null,
      weekJokerCount: 0,
      weekStartDate: getWeekStartDate(),
    };
  }

  // コマンド処理 - @Bot接頭辞を削除し、各種コマンドに対応

  // テスト集計コマンド（開発者用）- 元のコマンド形式を維持
  if (text.trim() === "@Bot テスト集計") {
    // テスト用に即時集計を実行
    checkAllGroupReports();

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: BOT_CONFIG.messages.testAggregation,
    });
  }

  // テスト用時間設定 - 元のコマンド形式を維持
  const testTimeMatch = text.match(/@Bot テスト時間(\d{1,2}):(\d{2})/);
  if (testTimeMatch) {
    const hours = parseInt(testTimeMatch[1]);
    const minutes = parseInt(testTimeMatch[2]);

    // グローバル変数に現在時刻を保存（本番環境では削除すること）
    global.testTime = setTestTime(hours, minutes);

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: BOT_CONFIG.messages.testTimeSet
        .replace("{hours}", hours)
        .replace("{minutes}", minutes.toString().padStart(2, "0")),
    });
  }

  // 起床時間設定コマンド - @Bot接頭辞を削除、明日なしでも対応
  const timeSettingMatch = text.match(BOT_CONFIG.commands.setWakeupTime);
  if (timeSettingMatch) {
    return handleTimeSettingCommand(
      event,
      timeSettingMatch,
      userId,
      groupId,
      userName,
    );
  }

  // ぐっすりコマンド - @Bot接頭辞削除
  if (BOT_CONFIG.commands.goodSleep.some((cmd) => text.trim() === cmd)) {
    return handleGoodSleepCommand(event, userId, groupId, userName);
  }

  // ぐっすり取り消しコマンド - @Bot接頭辞削除
  if (BOT_CONFIG.commands.goodSleepCancel.some((cmd) => text.trim() === cmd)) {
    return handleGoodSleepCancelCommand(event, userId, groupId, userName);
  }

  // 記録確認コマンド - @Bot接頭辞削除、コマンド名変更
  if (BOT_CONFIG.commands.recordCheck.some((cmd) => text.trim() === cmd)) {
    return handleRecordCommand(event, userId, groupId);
  }

  // 設定確認コマンド - @Bot接頭辞削除、コマンド名変更
  if (BOT_CONFIG.commands.settingsCheck.some((cmd) => text.trim() === cmd)) {
    return handleSettingsCommand(event, userId, groupId, userName);
  }

  // ヘルプコマンド - @Bot接頭辞削除、コマンド名変更
  if (BOT_CONFIG.commands.help.some((cmd) => text.trim() === cmd)) {
    return handleHelpCommand(event);
  }

  // 起床報告の処理
  if (isWakeupReport(text)) {
    return handleWakeupReport(event, userId, groupId, userName);
  }

  // それ以外のメッセージは無視
  return Promise.resolve(null);
}

// 起床時間設定コマンド処理
function handleTimeSettingCommand(
  event,
  timeSettingMatch,
  userId,
  groupId,
  userName,
) {
  const hours = parseInt(timeSettingMatch[1]);
  // 分が省略されている場合は0分とする
  const minutes = timeSettingMatch[3] ? parseInt(timeSettingMatch[3]) : 0;

  // 時間のバリデーション
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: BOT_CONFIG.messages.timeFormatError,
    });
  }

  // 起床時間を設定
  botData.groups[groupId].users[userId].wakeupTime = { hours, minutes };
  botData.groups[groupId].users[userId].todayReported = false;
  saveData();

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: BOT_CONFIG.messages.timeSetSuccess
      .replace("{hours}", hours)
      .replace("{minutes}", minutes.toString().padStart(2, "0")),
  });
}

// 起床報告かどうかを判定
function isWakeupReport(text) {
  // 起床報告として認識するワード（BOT_CONFIGから取得）
  return BOT_CONFIG.commands.wakeupKeywords.some((keyword) =>
    text.includes(keyword),
  );
}

// 起床報告処理関数
function handleWakeupReport(event, userId, groupId, userName) {
  const now = global.testTime || new Date();
  const userInfo = botData.groups[groupId].users[userId];

  // 起床時間が設定されていない場合
  if (!userInfo.wakeupTime) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: BOT_CONFIG.messages.noTimeSet,
    });
  }

  // 同じ日に二回目の報告の場合
  if (isSameDay(now, userInfo.lastReport) && userInfo.todayReported) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: BOT_CONFIG.messages.wakeupAlreadyReported,
    });
  }

  // 起床報告を記録
  userInfo.lastReport = now;
  userInfo.todayReported = true;
  saveData();

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: BOT_CONFIG.messages.wakeupSuccess.replace("{userName}", userName),
  });
}

// 同じ日かどうかをチェック
function isSameDay(date1, date2) {
  if (!date1 || !date2) return false;

  const d1 = new Date(date1);
  const d2 = new Date(date2);

  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
}

// ぐっすりコマンド処理関数
function handleGoodSleepCommand(event, userId, groupId, userName) {
  const now = global.testTime || new Date();
  const userInfo = botData.groups[groupId].users[userId];

  // 現在の時刻が22時以降の場合はぐっすりを使用できない
  if (now.getHours() >= 22) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: BOT_CONFIG.messages.goodSleepTimeLimit,
    });
  }

  // 週の開始日が古い場合はリセット
  if (userInfo.weekStartDate) {
    const weekStart = new Date(userInfo.weekStartDate);
    const dayDiff = Math.floor((now - weekStart) / (1000 * 60 * 60 * 24));
    if (dayDiff >= 7) {
      userInfo.weekStartDate = getWeekStartDate();
      userInfo.weekJokerCount = 0;
    }
  } else {
    userInfo.weekStartDate = getWeekStartDate();
    userInfo.weekJokerCount = 0;
  }

  // 週に1回までしか使えない
  if (userInfo.weekJokerCount >= 1) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: BOT_CONFIG.messages.goodSleepWeeklyLimit,
    });
  }

  // ぐっすりを設定
  userInfo.jokerUsed = true;
  userInfo.lastJokerDate = now;
  userInfo.weekJokerCount += 1;
  saveData();

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: BOT_CONFIG.messages.goodSleepSuccess.replace("{userName}", userName),
  });
}

// ぐっすり取り消し処理関数
function handleGoodSleepCancelCommand(event, userId, groupId, userName) {
  const userInfo = botData.groups[groupId].users[userId];

  // ぐっすりを使用していない場合
  if (!userInfo.jokerUsed) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: BOT_CONFIG.messages.goodSleepNotUsed,
    });
  }

  // ぐっすりを取り消す
  userInfo.jokerUsed = false;
  userInfo.weekJokerCount -= 1; // 使用回数を元に戻す
  saveData();

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: BOT_CONFIG.messages.goodSleepCancelSuccess.replace(
      "{userName}",
      userName,
    ),
  });
}

// 記録確認コマンド
function handleRecordCommand(event, userId, groupId) {
  const streak = botData.groups[groupId].currentStreak;
  const best = botData.groups[groupId].bestStreak;

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: BOT_CONFIG.messages.recordStatus
      .replace("{streak}", streak)
      .replace("{best}", best),
  });
}

// 設定確認コマンド
function handleSettingsCommand(event, userId, groupId, userName) {
  const userInfo = botData.groups[groupId].users[userId];
  const wakeupTime = userInfo.wakeupTime;

  if (!wakeupTime) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: BOT_CONFIG.messages.noTimeSet,
    });
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: BOT_CONFIG.messages.userSettings
      .replace("{userName}", userName)
      .replace("{hours}", wakeupTime.hours)
      .replace("{minutes}", wakeupTime.minutes.toString().padStart(2, "0")),
  });
}

// ヘルプコマンド
function handleHelpCommand(event) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: BOT_CONFIG.messages.helpText,
  });
}

// 週の開始日（日曜日）を取得
function getWeekStartDate() {
  const now = new Date();
  const day = now.getDay(); // 0が日曜日、6が土曜日
  const diff = now.getDate() - day;
  const sunday = new Date(now.setDate(diff));
  sunday.setHours(0, 0, 0, 0);
  return sunday;
}

// 毎日12時に実行するクロンジョブ
cron.schedule("0 12 * * *", () => {
  checkAllGroupReports();
});

// 全グループのレポートをチェック
async function checkAllGroupReports() {
  const now = global.testTime || new Date();

  for (const groupId in botData.groups) {
    const groupInfo = botData.groups[groupId];
    const users = groupInfo.users;

    // レポート集計用の配列
    const successful = [];
    const failed = [];

    // 各ユーザーをチェック
    for (const userId in users) {
      const userInfo = users[userId];

      // 起床時間が設定されていない場合はスキップ
      if (!userInfo.wakeupTime) continue;

      // ぐっすりを使用している場合は成功扱い
      if (userInfo.jokerUsed) {
        successful.push(`${userInfo.name}(ぐっすり)`);
        userInfo.jokerUsed = false; // ぐっすりをリセット
        continue;
      }

      const wakeupTime = userInfo.wakeupTime;
      const lastReport = userInfo.lastReport;

      // 今日の予定起床時刻を作成
      const todayWakeupTime = new Date(now);
      todayWakeupTime.setHours(wakeupTime.hours, wakeupTime.minutes, 0, 0);

      // 起床報告がない、または遅れた場合は失敗
      if (
        !lastReport ||
        !isSameDay(now, lastReport) ||
        lastReport > todayWakeupTime
      ) {
        failed.push(userInfo.name);
      } else {
        successful.push(userInfo.name);
      }

      // 起床報告をリセット
      userInfo.todayReported = false;
    }

    // メッセージを作成して送信
    let message = "";

    if (failed.length === 0 && successful.length > 0) {
      // 全員成功
      groupInfo.currentStreak++;
      if (groupInfo.currentStreak > groupInfo.bestStreak) {
        groupInfo.bestStreak = groupInfo.currentStreak;
      }

      message = BOT_CONFIG.messages.allSuccess.replace(
        "{streak}",
        groupInfo.currentStreak,
      );
    } else if (failed.length > 0) {
      // 誰かが失敗
      message = BOT_CONFIG.messages.someoneFailure
        .replace("{failedUsers}", failed.join("さん、"))
        .replace("{oldStreak}", groupInfo.currentStreak);
      groupInfo.currentStreak = 0;
    }

    // メッセージがある場合のみ送信
    if (message && (successful.length > 0 || failed.length > 0)) {
      try {
        await client.pushMessage(groupId, {
          type: "text",
          text: message,
        });
      } catch (error) {
        console.error("メッセージ送信エラー:", error);
      }
    }
  }

  // 変更を保存
  saveData();
}

// サーバーの起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Keep-alive機能を完全に無効化（コメントアウト）
/*
setInterval(() => {
  http.get(`http://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`);
}, 280000);
*/
