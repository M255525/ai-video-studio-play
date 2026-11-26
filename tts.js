/* 官方語音服務共用模組（ai-voice-generator/web 與 ai-video-studio/AIvideo_Studio_web 各一份，要逐字一致）
 *
 * 2026-11-25 取代原本的語音代理 Worker（模擬瀏覽器連未公開的朗讀服務，已停用，不可恢復）。
 * 只使用各家公開的官方 API，由使用者自備金鑰、瀏覽器直接呼叫，不經過本站任何伺服器。
 * 金鑰只存在這台電腦的瀏覽器（localStorage），兩個工具同網域共用一份設定。
 */
(function () {
  'use strict';
  var KEY = 'mk.tts.v1';
  var OPENAI_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];
  var GEMINI_VOICES = [['Kore', '女聲・清楚'], ['Aoede', '女聲・輕快'], ['Leda', '女聲・年輕'], ['Zephyr', '女聲・明亮'],
    ['Charon', '男聲・沉穩'], ['Puck', '男聲・活潑'], ['Fenrir', '男聲・有力'], ['Orus', '男聲・堅定']];
  var PROVIDERS = {
    gemini: { label: 'Google Gemini', model: 'gemini-3.8-flash-tts', max: 2000, keyUrl: 'https://aistudio.google.com/apikey', note: '費用與免費額度以 Google 公告為準。' },
    openai: { label: 'OpenAI', model: 'gpt-4o-mini-tts', max: 2000, keyUrl: 'https://platform.openai.com/api-keys', note: '依用量計費；OpenAI 公告這類語音模型預定 2027-01-06 停用。' },
    elevenlabs: { label: 'ElevenLabs', model: 'eleven_multilingual_v2', max: 2000, keyUrl: 'https://elevenlabs.io/app/settings/api-keys', note: '依方案計費；請只使用你有權使用的聲音。' }
  };
  var listeners = [];

  function blank() { return { provider: 'gemini', keys: {}, models: {}, elevenVoices: '' }; }
  var mem = null;
  function cfg() {
    if (mem) return mem;
    mem = blank();
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && typeof s === 'object') {
        if (PROVIDERS[s.provider]) mem.provider = s.provider;
        mem.keys = s.keys && typeof s.keys === 'object' ? s.keys : {};
        mem.models = s.models && typeof s.models === 'object' ? s.models : {};
        mem.elevenVoices = typeof s.elevenVoices === 'string' ? s.elevenVoices : '';
      }
    } catch (e) {}
    return mem;
  }
  function saveCfg() { try { localStorage.setItem(KEY, JSON.stringify(cfg())); } catch (e) {} }
  function apiKey() { return String(cfg().keys[cfg().provider] || '').trim(); }
  function model() { return String(cfg().models[cfg().provider] || '').trim() || PROVIDERS[cfg().provider].model; }

  /* 目前服務商的聲音：[{id, name}] */
  function voices() {
    var p = cfg().provider;
    if (p === 'gemini') return GEMINI_VOICES.map(function (v) { return { id: v[0], name: v[1] + '（' + v[0] + '）' }; });
    if (p === 'elevenlabs') {
      return cfg().elevenVoices.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) {
        var m = /^(.*?)[=＝]\s*([A-Za-z0-9]{8,40})$/.exec(l);
        if (m) return { id: m[2], name: m[1].trim() || m[2] };
        return /^[A-Za-z0-9]{8,40}$/.test(l) ? { id: l, name: l } : null;
      }).filter(Boolean);
    }
    return OPENAI_VOICES.map(function (v) { return { id: v, name: v }; });
  }
  function canSpeed() {
    var p = cfg().provider;
    return p === 'elevenlabs' || (p === 'openai' && /^tts-1/.test(model()));
  }
  function pctOf(rate) { var n = parseInt(rate, 10); return isFinite(n) ? Math.max(-50, Math.min(100, n)) : 0; }
  function b64ToBytes(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  /* Gemini interactions 回應：steps[].content[] 裡 type 為 audio 的最後一筆 */
  function geminiAudio(j) {
    var hit = null;
    ((j && j.steps) || []).forEach(function (s) {
      if (s && s.type === 'model_output') (s.content || []).forEach(function (c) { if (c && c.type === 'audio' && c.data) hit = c; });
    });
    if (!hit && j && j.output_audio && j.output_audio.data) hit = j.output_audio;
    return hit ? b64ToBytes(hit.data) : null;
  }
  function request(text, voiceId, rate) {
    var p = cfg().provider, k = apiKey(), m = model(), pct = pctOf(rate), body;
    if (p === 'gemini') {
      return { url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': k },
        body: { model: m, input: [{ type: 'user_input', content: [{ type: 'text', text: text }] }], response_format: { type: 'audio' },
          generation_config: { speech_config: [{ voice: voiceId }] } } };
    }
    if (p === 'elevenlabs') {
      body = { text: text, model_id: m };
      if (pct) body.voice_settings = { speed: Math.max(0.7, Math.min(1.2, 1 + pct / 100)) };
      return { url: 'https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voiceId) + '?output_format=mp3_44100_128',
        headers: { 'content-type': 'application/json', 'xi-api-key': k, accept: 'audio/mpeg' }, body: body };
    }
    body = { model: m, input: text, voice: voiceId, response_format: 'mp3' };
    if (pct && canSpeed()) body.speed = Math.max(0.25, Math.min(4, 1 + pct / 100));
    return { url: 'https://api.openai.com/v1/audio/speech', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + k }, body: body };
  }
  function explain(status, msg) {
    if (status === 401 || status === 403) return '金鑰不正確或沒有使用權限，請檢查「語音服務」設定裡的金鑰（' + status + '）';
    if (status === 404) return '找不到這個模型或聲音，請檢查設定（404）：' + msg;
    if (status === 429) return '額度用完或太頻繁（429），請稍後再試或檢查帳戶額度';
    if (status === 400 && /api key/i.test(msg)) return '金鑰不正確，請檢查「語音服務」設定裡的金鑰';
    return '語音服務回應 ' + status + '：' + msg;
  }
  /* 合成一段語音，回傳 {bytes, mime, ext} */
  async function speak(text, voiceId, rate) {
    var P = PROVIDERS[cfg().provider];
    if (!apiKey()) throw new Error('尚未填入 ' + P.label + ' 的 API 金鑰，請到「語音服務」設定填入');
    if (!voiceId) throw new Error('尚未選擇聲音' + (cfg().provider === 'elevenlabs' ? '，請在「語音服務」設定填入 ElevenLabs 的語音 ID' : ''));
    if (text.length > P.max) throw new Error('單次最多 ' + P.max + ' 字，目前 ' + text.length + ' 字，請分段');
    var r = request(text, voiceId, rate);
    for (var attempt = 1; ; attempt++) {
      var resp;
      try {
        resp = await fetch(r.url, { method: 'POST', headers: r.headers, body: JSON.stringify(r.body), signal: AbortSignal.timeout(120000) });
      } catch (e) {
        throw new Error(e && e.name === 'TimeoutError' ? '語音服務逾時，請稍後再試' : '連不上語音服務，請檢查網路');
      }
      if (resp.ok) {
        if (cfg().provider === 'gemini') {
          var b = geminiAudio(await resp.json());
          if (!b) throw new Error('Gemini 沒有回傳音訊，請再試一次或換一個模型');
          return { bytes: b, mime: 'audio/wav', ext: 'wav' };
        }
        return { bytes: new Uint8Array(await resp.arrayBuffer()), mime: 'audio/mpeg', ext: 'mp3' };
      }
      var raw = await resp.text(), msg = raw.slice(0, 200);
      try { var j = JSON.parse(raw); msg = String((j.error && j.error.message) || (j.detail && (j.detail.message || j.detail)) || msg).slice(0, 200); } catch (e) {}
      if ([429, 500, 502, 503, 529].indexOf(resp.status) >= 0 && attempt < 3) {
        await new Promise(function (f) { setTimeout(f, attempt * 4000); });
        continue;
      }
      throw new Error(explain(resp.status, msg));
    }
  }

  /* WAV（16-bit PCM）解析與組裝，給 Gemini 的字幕配音與對話用 */
  function wavParse(b) {
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    function tag(o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }
    if (b.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
    var o = 12, sr = 0, ch = 0, bits = 0;
    while (o + 8 <= b.length) {
      var id = tag(o), len = dv.getUint32(o + 4, true);
      if (id === 'fmt ') { ch = dv.getUint16(o + 10, true); sr = dv.getUint32(o + 12, true); bits = dv.getUint16(o + 22, true); }
      else if (id === 'data') {
        if (bits !== 16 || !sr || !ch) return null;
        var n = Math.min(len, b.length - o - 8), samples = Math.floor(n / 2), pcm = new Int16Array(samples);
        for (var i = 0; i < samples; i++) pcm[i] = dv.getInt16(o + 8 + i * 2, true);
        return { fmt: { sr: sr, ch: ch, wav: true }, pcm: pcm, duration: samples / ch / sr };
      }
      o += 8 + len + (len & 1);
    }
    return null;
  }
  function WavTimeline() { this.parts = []; this.n = 0; this.fmt = null; }
  WavTimeline.prototype = {
    get time() { return this.fmt ? this.n / this.fmt.ch / this.fmt.sr : 0; },
    padTo: function (sec) {
      if (!this.fmt) return;
      var want = Math.round(sec * this.fmt.sr) * this.fmt.ch - this.n;
      if (want > 0) { this.parts.push(new Int16Array(want)); this.n += want; }
    },
    place: function (seg, at) {
      if (!seg.fmt) return this.time;
      if (!this.fmt) this.fmt = seg.fmt;
      if (seg.fmt.sr !== this.fmt.sr || seg.fmt.ch !== this.fmt.ch) throw new Error('這一句的音訊格式跟前面不同，請使用同一種服務');
      this.padTo(Math.max(at, this.time));
      var start = this.time;
      this.parts.push(seg.pcm); this.n += seg.pcm.length;
      return start;
    },
    blob: function () {
      var f = this.fmt || { sr: 24000, ch: 1 }, bytes = this.n * 2, h = new DataView(new ArrayBuffer(44));
      function s(o, t) { for (var i = 0; i < t.length; i++) h.setUint8(o + i, t.charCodeAt(i)); }
      s(0, 'RIFF'); h.setUint32(4, 36 + bytes, true); s(8, 'WAVEfmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true);
      h.setUint16(22, f.ch, true); h.setUint32(24, f.sr, true); h.setUint32(28, f.sr * f.ch * 2, true); h.setUint16(32, f.ch * 2, true);
      h.setUint16(34, 16, true); s(36, 'data'); h.setUint32(40, bytes, true);
      return new Blob([h.buffer].concat(this.parts), { type: 'audio/wav' });
    }
  };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  /* 設定面板：box 是容器元素；變更後呼叫 onChange 註冊的函式 */
  function mount(box) {
    /* 重畫會移除還有焦點的欄位，瀏覽器會因此再補送一次 change：
       重畫中只存值不再重畫（避免巢狀 innerHTML 例外），存值依欄位畫出當時的服務商（data-p），不會存到切換後的那一家 */
    var drawing = false, again = false;
    function draw() {
      if (drawing) { again = true; return; }
      var act = document.activeElement, back = act && box.contains(act) ? act.getAttribute('data-t') : null;
      drawing = true;
      try { do { again = false; render(); } while (again); } finally { drawing = false; }
      var el = back && box.querySelector('[data-t=' + back + ']');
      if (el) el.focus({ preventScroll: true });
    }
    function render() {
      var c = cfg(), P = PROVIDERS[c.provider];
      box.innerHTML = '<div class="mktts" data-p="' + c.provider + '">'
        + '<label>語音服務<select data-t="provider">' + Object.keys(PROVIDERS).map(function (k) { return '<option value="' + k + '"' + (k === c.provider ? ' selected' : '') + '>' + PROVIDERS[k].label + '</option>'; }).join('') + '</select></label>'
        + '<label>API 金鑰<input type="password" data-t="key" autocomplete="off" value="' + esc(c.keys[c.provider] || '') + '" placeholder="貼上 ' + P.label + ' 的 API 金鑰"></label>'
        + '<label>模型（已帶入建議模型，通常不用改）<input type="text" data-t="model" value="' + esc(c.models[c.provider] || P.model) + '" placeholder="' + P.model + '"></label>'
        + (c.models[c.provider] && c.models[c.provider] !== P.model ? '<p class="hint">目前用自訂模型，建議模型是 ' + P.model + '。<button type="button" data-t="usedef">改回建議模型</button></p>' : '<p class="hint">選好服務會自動帶入建議模型，只要貼上 API 金鑰就能配音。</p>')
        + (c.provider === 'elevenlabs' ? '<label>語音 ID（一行一個，可寫「名稱=ID」）<textarea data-t="eleven" rows="3" placeholder="旁白=21m00Tcm4TlvDq8ikWAM">' + esc(c.elevenVoices) + '</textarea></label>' : '')
        + '<p class="hint">金鑰申請：<a href="' + P.keyUrl + '" target="_blank" rel="noopener">' + P.label + '</a>。' + P.note
        + '金鑰只存在這台電腦的瀏覽器，文字直接送到你選的服務商，不經過本站伺服器。' + (canSpeed() ? '' : '這個設定不支援調整語速。') + '</p>'
        + '<p class="hint">發布時請依各服務商規定，讓聽眾知道這是 AI 合成語音。</p></div>';
    }
    box.addEventListener('change', function (e) {
      var t = e.target.getAttribute && e.target.getAttribute('data-t'), c = cfg();
      if (!t) return;
      var host = e.target.closest('.mktts'), p = (host && host.getAttribute('data-p')) || c.provider;
      if (t === 'provider') c.provider = PROVIDERS[e.target.value] ? e.target.value : 'gemini';
      if (t === 'key') c.keys[p] = e.target.value.trim();
      if (t === 'model') { var mv = e.target.value.trim(); if (!mv || mv === PROVIDERS[p].model) delete c.models[p]; else c.models[p] = mv; }
      if (t === 'eleven') c.elevenVoices = e.target.value;
      saveCfg();
      if (t !== 'key') draw();
      listeners.forEach(function (f) { f(); });
    });
    box.addEventListener('click', function (e) {
      if (!e.target.getAttribute || e.target.getAttribute('data-t') !== 'usedef') return;
      delete cfg().models[cfg().provider];
      saveCfg(); draw();
      listeners.forEach(function (f) { f(); });
    });
    draw();
  }

  window.MKTTS = {
    PROVIDERS: PROVIDERS, cfg: cfg, voices: voices, canSpeed: canSpeed, hasKey: function () { return !!apiKey(); },
    label: function () { return PROVIDERS[cfg().provider].label; }, speak: speak, wavParse: wavParse, WavTimeline: WavTimeline,
    mount: mount, onChange: function (f) { listeners.push(f); }
  };
  try { ['avgWeb_ttsWorkerUrl', 'avsWeb_ttsWorkerUrl'].forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {}
})();
