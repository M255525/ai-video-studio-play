/**
 * TTS 代理 Worker — 唯一存在的理由：瀏覽器不允許 JS 自訂 WebSocket 的 Origin header，
 * 而 Microsoft 這個線上語音合成服務會檢查 Origin，所以純前端頁面連不上。
 * 這個 Worker 跑在 Cloudflare 的伺服器端（不是瀏覽器），可以自訂 header，代替頁面去連。
 * 除此之外全部（Pexels 搜尋/下載、影片合成、字幕、浮水印）都在瀏覽器裡完成，這裡只轉發配音。
 */

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WIN_EPOCH = 11644473600;

// Windows 檔案時間的 100-ns tick，每 5 分鐘換一次，跟微軟服務端的容許誤差對齊
function gecTicks() {
  let sec = Math.floor(Date.now() / 1000) + WIN_EPOCH;
  sec -= sec % 300;
  return `${BigInt(sec) * 10000000n}`;
}
function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// v1 簽章：SHA-256(ticks + token)，只剩 api.msedgeservices.com 備援端點接受
async function generateSecMsGecV1() {
  const enc = new TextEncoder().encode(`${gecTicks()}${TRUSTED_CLIENT_TOKEN}`);
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc)));
}

// v2 簽章（2026-10 下旬起舊主機改要這個，Sec-MS-GEC-Version=2-...）：移植自 edge-tts 7.3.1
// 的 drm.py——自訂初始狀態的 SHA-256 加上 CS64 雜湊，格式 "<16 hex>-<64 hex>"。
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const SHA256_INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const SHA256_STATE = [0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2];
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0,
  0xf9e70ab6, 0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564,
];
const SHA256_ADJUSTMENT = 0xc9dc06a7;
const SHA256_BLOCK_K = SHA256_K.map((k, i) => (i === 14 ? SHA256_ADJUSTMENT : k));
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0;
const CS64_COEFFICIENTS = [
  [0xe82e91b1, 0xb32700d0], [0x44de24c6, 0x88dff51d], [0x3beb65bc, 0x29514038], [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5], [0x314ef5d5, 0x26e55f3c], [0xe92491b1, 0x607801c6], [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da], [0xda79fa60, 0x207cc464], [0xbed20560, 0x3c3c74f3], [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1], [0xcb49e3c6, 0xc5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
const rol16 = (x) => ((x << 16) | (x >>> 16)) >>> 0;
const mul = (a, b) => Math.imul(a, b) >>> 0;
const sigma0 = (x) => (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
const sigma1 = (x) => (rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10)) >>> 0;

function expandSchedule(w, first = 16) {
  for (let i = first; i < 64; i++) w.push((sigma1(w[i - 2]) + w[i - 7] + sigma0(w[i - 15]) + w[i - 16]) >>> 0);
}
function sha256Rounds(state, w, first, K) {
  let [a, b, c, d, e, f, g, h] = state;
  for (let i = first; i < 64; i++) {
    const t1 = (h + ((rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0) + ((g ^ (e & (f ^ g))) >>> 0) + K[i] + w[i]) >>> 0;
    const t2 = (((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0) + (((a & b) | (c & (a | b))) >>> 0)) >>> 0;
    h = g; g = f; f = e; e = (d + t1) >>> 0;
    d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }
  return [a, b, c, d, e, f, g, h];
}
function sha256Init(d) {
  const w = new Array(14).fill(0);
  w.push(((d[0] << 16) | (d[1] << 8) | d[2]) >>> 0);
  w.push(((d[3] << 24) | (d[4] << 16) | (d[5] << 8) | d[6]) >>> 0);
  for (let i = 16; i < 30; i++) {
    let v = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) v += i === 16 ? (sigma1(w[i - 2]) ^ SHA256_SIGMA1_ADJUSTMENT) >>> 0 : sigma1(w[i - 2]);
    if (i - 7 >= 14) v += w[i - 7];
    if (i - 15 >= 14) v += i === 29 ? (sigma0(w[i - 15]) ^ SHA256_SIGMA0_ADJUSTMENT) >>> 0 : sigma0(w[i - 15]);
    w.push(v >>> 0);
  }
  w.push((sigma1(w[28]) + w[23] + sigma0(w[15]) + w[14] + SHA256_ADJUSTMENT - SHA256_K[14]) >>> 0);
  expandSchedule(w, 31);
  const working = sha256Rounds(SHA256_STATE, w, 14, SHA256_BLOCK_K);
  return SHA256_INITIAL.map((x, i) => (x + working[i]) >>> 0);
}
function sha256Digest(data) {
  const length = 57 + data.length;
  const zeros = (((55 - length) % 64) + 64) % 64;
  const tail = data.slice(7);
  const padded = new Uint8Array(tail.length + 1 + zeros + 8);
  padded.set(tail);
  padded[tail.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setBigUint64(padded.length - 8, BigInt(length * 8));
  let state = sha256Init(data);
  for (let off = 0; off < padded.length; off += 64) {
    const w = [];
    for (let i = 0; i < 16; i++) w.push(dv.getUint32(off + i * 4));
    expandSchedule(w);
    const working = sha256Rounds(state, w, 0, SHA256_K);
    state = state.map((x, i) => (x + working[i]) >>> 0);
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  state.forEach((x, i) => odv.setUint32(i * 4, x));
  return out;
}
function cs64Digest(data, digest) {
  const ddv = new DataView(digest.buffer);
  const keyA = (ddv.getUint32(0, true) | 1) >>> 0;
  const keyB = (ddv.getUint32(4, true) | 1) >>> 0;
  const factors = [mul(keyA, CS64_FACTOR), mul(keyB, CS64_FACTOR)];
  const terms = CS64_COEFFICIENTS.map(([coef], i) => mul(coef, factors[i % 2]));
  const offsets = CS64_COEFFICIENTS.map(([, o]) => o);
  // 前面補一個 0x00，再補零到 4 的倍數、切成 little-endian 32-bit word，個數補成偶數
  const raw = new Uint8Array(Math.ceil((data.length + 1) / 4) * 4);
  raw.set(data, 1);
  const rdv = new DataView(raw.buffer);
  const words = [];
  for (let i = 0; i < raw.length; i += 4) words.push(rdv.getUint32(i, true));
  if (words.length % 2) words.push(0);
  words.forEach((word, i) => {
    let term = Math.imul(word, i % 2 === 0 ? keyA : keyB);
    let offset = Math.imul(rol16(word), i % 2 === 0 ? 0xef0569fb : 0xc31713db);
    if (i === 0) {
      term += Math.imul(CS64_ADJUSTMENT0, factors[0]);
      offset += CS64_ADJUSTMENT1;
    }
    terms.push(term >>> 0);
    offsets.push(offset >>> 0);
  });
  let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let t = rol16((offsets[i] + x) >>> 0);
    let q = mul(t, 0x76f50f34);
    swapAcc = (swapAcc + ((Math.imul(rol16(q), 0xc3efea97) + q) >>> 0)) >>> 0;
    t = rol16((offsets[i + 1] + y) >>> 0);
    q = mul(t, 0x1881ce3c);
    swapLast = (Math.imul(rol16(q), 0x35bd1ec9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (Math.imul(state, keyA) + x) >>> 0;
    state = mul(rol16(state), 0xcf98b111);
    state = mul(rol16(state), 0x87085b9f);
    state = mul(rol16(state), 0x12ceb96d);
    state = mul(rol16(state), 0x257e1d83);
    acc = (acc + state) >>> 0;
    t = (Math.imul(state, keyB) + y) >>> 0;
    t = mul(rol16(t), 0xa27416f5);
    t = mul(rol16(t), 0xd38396ff);
    state = mul(rol16(mul(rol16(t), 0x7c932b89)), 0xbfa49f69);
    acc = (acc + state) >>> 0;
  }
  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}
function generateSecMsGecV2() {
  const data = new TextEncoder().encode(`${gecTicks()}${TRUSTED_CLIENT_TOKEN}`);
  const digest = sha256Digest(data);
  const cs = new Uint8Array(8);
  const cdv = new DataView(cs.buffer);
  cs64Digest(data, digest).forEach((x, i) => cdv.setUint32(i * 4, x, true));
  return `${toHex(cs)}-${toHex(digest)}`;
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

// 注意：這裡用 https:// 不是 wss://——Cloudflare Workers 的 fetch() 靠 Upgrade header
// 觸發 WebSocket 升級，直接寫 wss:// 反而會被拒絕（wrangler dev 本機測試時已驗證過這點）。
// 2026-10 中旬舊主機 speech.platform.bing.com 對 v1 簽章回 403，曾改走 api.msedgeservices.com
// （rany2/edge-tts PR #491）；10 月下旬 Cloudflare 連那個新端點也升級失敗，改用 edge-tts 7.3.1
// 的做法：回到舊主機、帶 v2 簽章。新端點留作備援，依序嘗試。
async function edgeEndpoints() {
  const connId = connectId();
  return [
    'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1' +
      `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${connId}` +
      `&Sec-MS-GEC=${generateSecMsGecV2()}&Sec-MS-GEC-Version=2-143.0.3650.75`,
    'https://api.msedgeservices.com/tts/cognitiveservices/websocket/v1' +
      `?Ocp-Apim-Subscription-Key=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${connId}` +
      `&Sec-MS-GEC=${await generateSecMsGecV1()}&Sec-MS-GEC-Version=1-143.0.3650.75`,
  ];
}

async function openEdgeSocket() {
  const statuses = [];
  for (const url of await edgeEndpoints()) {
    const resp = await fetch(url, {
      headers: {
        Upgrade: 'websocket',
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        // 這個 Origin 是關鍵：模擬微軟 Edge 瀏覽器內建「朗讀」功能的擴充功能來源，
        // 服務端只接受這個 Origin，這正是瀏覽器頁面自己連不上、需要這個 Worker 代打的原因。
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: `muid=${crypto.randomUUID().replace(/-/g, '').toUpperCase()};`,
      },
    });
    if (resp.webSocket) return resp.webSocket;
    statuses.push(resp.status);
  }
  throw new Error(`無法建立到語音服務的連線（Upgrade 失敗，status=${statuses.join('/')}）`);
}

async function synthesize(text, voice, rate) {
  const ws = await openEdgeSocket();
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

// 備援：Google 翻譯語音（免金鑰、只有一種女聲、不支援語速）。單次請求上限約 200 字，
// 依標點切段後逐段抓 mp3 再直接位元組相接（mp3 frame 相接即可連續播放）。
function splitForGoogle(text, max = 180) {
  const chunks = [];
  let buf = '';
  for (let piece of text.split(/(?<=[。！？!?；;，,、\n])/)) {
    piece = piece.trim();
    while (piece.length > max) {
      if (buf) { chunks.push(buf); buf = ''; }
      chunks.push(piece.slice(0, max));
      piece = piece.slice(max);
    }
    if (buf.length + piece.length > max) { chunks.push(buf); buf = ''; }
    buf += piece;
  }
  if (buf) chunks.push(buf);
  return chunks.filter((c) => c.trim());
}
async function synthesizeGoogle(text, lang) {
  const parts = [];
  for (const chunk of splitForGoogle(text)) {
    const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob' +
      `&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(chunk)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`Google 語音連線失敗（status=${r.status}）`);
    parts.push(new Uint8Array(await r.arrayBuffer()));
  }
  const out = new Uint8Array(parts.reduce((a, c) => a + c.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
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
      const gLang = /^google:(zh-TW|zh-CN)$/.exec(voice);
      let audio;
      if (gLang) {
        audio = await synthesizeGoogle(text, gLang[1]);
      } else {
        try {
          audio = await synthesize(text, voice, rate);
        } catch (e) {
          // 新端點對短時間內連續請求會回 429（雙人對話逐句呼叫時最容易遇到），等一下重試一次
          if (!/status=429/.test(String(e.message))) throw e;
          await new Promise((r) => setTimeout(r, 1500));
          audio = await synthesize(text, voice, rate);
        }
      }
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
