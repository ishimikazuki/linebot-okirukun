// 必要なパッケージのインポート
const express = require("express");
const line = require("@line/bot-sdk");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

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

  // メンションを確認
  const isMentioned =
    event.message.mention &&
    event.message.mention.mentionees &&
    event.message.mention.mentionees.some(
      (m) => m.userId === process.env.BOT_USER_ID,
    );

  // 従来の「@Bot」コマンドか、Botへのメンションがある場合
  if (text.match(/^@Bot\s+(.+)/i) || isMentioned) {
    // メンションの場合は@Botプレフィックスを削除したテキストを使用
    let commandText = text;
    if (isMentioned) {
      // メンション部分を削除してコマンドテキストを抽出
      commandText = "@Bot " + text.replace(/@[\w]+/, "").trim();
    }
    return handleCommand(event, commandText, userId, groupId, userName);
  }

  // 起床報告の処理
  if (isWakeupReport(text)) {
    return handleWakeupReport(event, userId, groupId, userName);
  }

  // それ以外のメッセージは無視
  return Promise.resolve(null);
}

// コマンド処理関数
function handleCommand(event, text, userId, groupId, userName) {
  const commandMatch = text.match(/^@Bot\s+(.+)/i);
  if (!commandMatch) return Promise.resolve(null);

  const command = commandMatch[1].trim();

  // ジョーカー使用コマンド
  if (
    command === "明日パス" ||
    command === "明日休み" ||
    command === "ジョーカー"
  ) {
    return handleJokerCommand(event, userId, groupId, userName);
  }

  // ジョーカー取り消しコマンド
  if (
    command === "ジョーカー取消" ||
    command === "ジョーカー取り消し" ||
    command === "ジョーカーキャンセル"
  ) {
    return handleJokerCancelCommand(event, userId, groupId, userName);
  }

  // テスト集計コマンド（開発者用）
  if (command === "テスト集計") {
    // テスト用に即時集計を実行
    checkAllGroupReports();

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "テスト用に集計を実行しました。",
    });
  }

  // テスト用時間設定
  const testTimeMatch = command.match(/テスト時間(\d{1,2}):(\d{2})/);
  if (testTimeMatch) {
    const hours = parseInt(testTimeMatch[1]);
    const minutes = parseInt(testTimeMatch[2]);

    // グローバル変数に現在時刻を保存（本番環境では削除すること）
    global.testTime = setTestTime(hours, minutes);

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `テスト用時間を${hours}:${minutes.toString().padStart(2, "0")}に設定しました。`,
    });
  }

  // 起床時間設定コマンド
  const timeSettingMatch = command.match(/明日は?(\d{1,2}):(\d{2})に起きる/);
  if (timeSettingMatch) {
    const hours = parseInt(timeSettingMatch[1]);
    const minutes = parseInt(timeSettingMatch[2]);

    // 時間のバリデーション
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "時間の形式が正しくありません。例: @Bot 明日7:00に起きる",
      });
    }

    // 起床時間を設定
    botData.groups[groupId].users[userId].wakeupTime = { hours, minutes };
    botData.groups[groupId].users[userId].todayReported = false;
    saveData();

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `OK！${hours}:${minutes.toString().padStart(2, "0")}に設定しました⏰`,
    });
  }

  // ヘルプコマンド
  if (command === "ヘルプ" || command === "help") {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `【使い方】
・起床時間設定: @Bot 明日7:00に起きる
・起床報告: 「起きた！」とメッセージを送る
・ジョーカー: @Bot ジョーカー (22時までに宣言で翌日パス、週1回のみ)
・ジョーカー取消: @Bot ジョーカー取消
・毎日12:00に全員の結果を集計します`,
    });
  }

  // 記録確認コマンド
  if (command === "記録" || command === "record") {
    const streak = botData.groups[groupId].currentStreak;
    const best = botData.groups[groupId].bestStreak;

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `現在の連続記録: ${streak}日\n最高連続記録: ${best}日`,
    });
  }

  // 設定確認コマンド
  if (command === "設定" || command === "settings") {
    const userInfo = botData.groups[groupId].users[userId];
    const wakeupTime = userInfo.wakeupTime;

    if (!wakeupTime) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "起床時間が設定されていません。\n@Bot 明日7:00に起きる で設定してください。",
      });
    }

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `${userName}さんの起床時間: ${wakeupTime.hours}:${wakeupTime.minutes.toString().padStart(2, "0")}`,
    });
  }

  // 不明なコマンド
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "コマンドが認識できませんでした。\n@Bot help でヘルプを表示します。",
  });
}

// 起床報告かどうかを判定
function isWakeupReport(text) {
  // 起床報告として認識するワード
  const wakeupKeywords = ["起きた", "起床", "おはよう", "朝"];
  return wakeupKeywords.some((keyword) => text.includes(keyword));
}

// 起床報告処理関数
function handleWakeupReport(event, userId, groupId, userName) {
  const now = global.testTime || new Date();
  const userInfo = botData.groups[groupId].users[userId];

  // 起床時間が設定されていない場合
  if (!userInfo.wakeupTime) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "起床時間が設定されていません。\n@Bot 明日7:00に起きる で設定してください。",
    });
  }

  // 同じ日に二回目の報告の場合
  if (isSameDay(now, userInfo.lastReport) && userInfo.todayReported) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "今日はすでに起床報告済みです！",
    });
  }

  // 起床報告を記録
  userInfo.lastReport = now;
  userInfo.todayReported = true;
  saveData();

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `${userName}さん、起床報告を記録しました✔️`,
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

// ジョーカーコマンド処理関数
function handleJokerCommand(event, userId, groupId, userName) {
  const now = global.testTime || new Date();
  const userInfo = botData.groups[groupId].users[userId];

  // 現在の時刻が22時以降の場合はジョーカーを使用できない
  if (now.getHours() >= 22) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "ジョーカーは22時までに宣言する必要があります。",
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
      text: "ジョーカーは週に1回しか使用できません。",
    });
  }

  // ジョーカーを設定
  userInfo.jokerUsed = true;
  userInfo.lastJokerDate = now;
  userInfo.weekJokerCount += 1;
  saveData();

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `${userName}さん、明日の早起きはパスします。ゆっくり休んでください😴\n（週に1回のジョーカーを使用しました）`,
  });
}

// ジョーカー取り消し処理関数
function handleJokerCancelCommand(event, userId, groupId, userName) {
  const userInfo = botData.groups[groupId].users[userId];

  // ジョーカーを使用していない場合
  if (!userInfo.jokerUsed) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "ジョーカーを使用していないため、取り消しできません。",
    });
  }

  // ジョーカーを取り消す
  userInfo.jokerUsed = false;
  userInfo.weekJokerCount -= 1; // 使用回数を元に戻す
  saveData();

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `${userName}さん、ジョーカーの使用を取り消しました。明日の早起きは通常通り必要です。`,
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

      // ジョーカーを使用している場合は成功扱い
      if (userInfo.jokerUsed) {
        successful.push(`${userInfo.name}(ジョーカー)`);
        userInfo.jokerUsed = false; // ジョーカーをリセット
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

      message = `全員が時間通りに起きました！連続記録は${groupInfo.currentStreak}日目です🎉`;
    } else if (failed.length > 0) {
      // 誰かが失敗
      message = `⚠️ ${failed.join("さん、")}さんが寝坊しました…連続記録はリセットされます💀\n（${groupInfo.currentStreak}日でした）`;
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
