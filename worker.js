/**
 * TTS 代理 Worker — 唯一存在的理由：瀏覽器不允許 JS 自訂 WebSocket 的 Origin header，
 * 而 Microsoft 這個線上語音合成服務會檢查 Origin，所以純前端頁面連不上。
 * 這個 Worker 跑在 Cloudflare 的伺服器端（不是瀏覽器），可以自訂 header，代替頁面去連。
 * 除此之外全部（Pexels 搜尋/下載、影片合成、字幕、浮水印）都在瀏覽器裡完成，這裡只轉發配音。
 */

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WIN_EPOCH = 11644473600;

async function generateSecMsGec() {
  let ticks = Date.now() / 1000;
  ticks += WIN_EPOCH;
  ticks -= ticks % 300; // 每 5 分鐘換一次，跟微軟服務端的容許誤差對齊
  ticks *= 1e9 / 100; // 換算成 Windows 檔案時間的 100-ns tick
  const strToHash = `${Math.floor(ticks)}${TRUSTED_CLIENT_TOKEN}`;
  const enc = new TextEncoder().encode(strToHash);
  const hashBuf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}
function connectId() {
  return crypto.randomUUID().replace(/-/g, '');
}
function dateToString() {
  return new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
}
function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function synthesize(text, voice, rate) {
  const gec = await generateSecMsGec();
  const connId = connectId();
  // 注意：這裡用 https:// 不是 wss://——Cloudflare Workers 的 fetch() 靠 Upgrade header
  // 觸發 WebSocket 升級，直接寫 wss:// 反而會被拒絕（wrangler dev 本機測試時已驗證過這點）。
  const url =
    'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1' +
    `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${connId}` +
    `&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=1-135.0.3179.54`;

  const resp = await fetch(url, {
    headers: {
      Upgrade: 'websocket',
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      // 這個 Origin 是關鍵：模擬微軟 Edge 瀏覽器內建「朗讀」功能的擴充功能來源，
      // 服務端只接受這個 Origin，這正是瀏覽器頁面自己連不上、需要這個 Worker 代打的原因。
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: `muid=${crypto.randomUUID().replace(/-/g, '').toUpperCase()};`,
    },
  });
  const ws = resp.webSocket;
  if (!ws) {
    throw new Error(`無法建立到語音服務的連線（Upgrade 失敗，status=${resp.status}）`);
  }
  ws.accept();

  const audioChunks = [];
  let turnEnded = false;
  let errMsg = null;

  const finished = new Promise((resolve) => {
    ws.addEventListener('message', (ev) => {
      const data = ev.data;
      if (typeof data === 'string') {
        if (data.includes('Path:turn.end')) {
          turnEnded = true;
          ws.close();
          resolve();
        }
      } else {
        // headerLen 是「從訊息最開頭（含這兩個長度前綴 byte 自己）算起」到 header 區塊結尾的位移，
        // 不是「header 文字本身的長度」——這裡少算過一次，會把音訊資料開頭的 2 bytes（正是 MPEG
        // 同步字元 0xFF 0xF3）一起切掉，導致瀏覽器嚴格的解碼器認不出格式（ffmpeg 夠寬容才沒發現）。
        const buf = new Uint8Array(data);
        const headerLen = (buf[0] << 8) | buf[1];
        const header = new TextDecoder().decode(buf.slice(2, headerLen));
        const audio = buf.slice(headerLen + 2);
        if (header.includes('Path:audio') && audio.length > 0) audioChunks.push(audio);
      }
    });
    ws.addEventListener('close', () => {
      if (!turnEnded) resolve();
    });
    ws.addEventListener('error', () => {
      errMsg = '與語音服務的連線發生錯誤';
      resolve();
    });
  });

  ws.send(
    `X-Timestamp:${dateToString()}\r\n` +
      'Content-Type:application/json; charset=utf-8\r\n' +
      'Path:speech.config\r\n\r\n' +
      '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
      '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},' +
      '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
  );

  const ssml =
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${voice}'><prosody pitch='+0Hz' rate='${rate}' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`;
  ws.send(
    `X-RequestId:${connectId()}\r\n` +
      'Content-Type:application/ssml+xml\r\n' +
      `X-Timestamp:${dateToString()}Z\r\n` +
      `Path:ssml\r\n\r\n${ssml}`
  );

  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('逾時，請稍後再試')), 20000));
  await Promise.race([finished, timeout]);

  if (errMsg) throw new Error(errMsg);
  if (!audioChunks.length) throw new Error('沒有收到音訊資料');

  const total = audioChunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of audioChunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }
    try {
      const body = await request.json();
      const text = String(body.text || '').slice(0, 2000); // 每段長度上限，避免濫用
      const voice = String(body.voice || 'zh-TW-YunJheNeural');
      const rate = /^[+-]\d{1,3}%$/.test(body.rate) ? body.rate : '+0%';
      if (!text.trim()) {
        return new Response(JSON.stringify({ error: '沒有文字內容' }), {
          status: 400,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const audio = await synthesize(text, voice, rate);
      return new Response(audio, {
        headers: { ...CORS_HEADERS, 'Content-Type': 'audio/mpeg', 'Content-Length': String(audio.length) },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e.message || e) }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
  },
};
