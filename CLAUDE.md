# CLAUDE.md — ai-video-studio/AIvideo_Studio_web

「AI 影音工坊」的**純瀏覽器版**（2026-08-06 建立）。跟 [[AIvideo_Studio_online]]（需要 `python launcher.py` 本機後端）是完全不同的架構，目標是「打開網址就能玩」的 GitHub Pages 體驗，不需要下載安裝。這是使用者在同一次對話裡追加的需求：先做完 online 版（Python 後端）上傳 GitHub 之後，使用者又要「可以玩的 GitHub 網頁」，逼出這個全新的瀏覽器架構。

## 架構總覽

- **Pexels 搜尋／下載**：瀏覽器直接呼叫 `api.pexels.com` 與 `videos.pexels.com`（已用 `curl -H "Origin: ..."` 實測確認兩者都回 `Access-Control-Allow-Origin: *`，瀏覽器直連完全沒問題，不需要任何後端轉發）。
- **配音**：**這是唯一沒辦法純瀏覽器完成的一步**，需要 `worker.js`（部署到 Cloudflare Workers）代理轉發。原因與踩坑見下方「配音代理」一節，非常重要，之後任何人碰這個專案都要先讀。
- **合成**：`canvas` 逐幀畫面（cover 裁切＋字幕文字＋浮水印文字）+ `canvas.captureStream()` 拿視訊軌、`AudioContext.createMediaStreamDestination()` 拿音訊軌，兩軌合併餵給 `MediaRecorder` **即時錄製**（不是像 ffmpeg 那樣可以加速轉檔，錄製時間 ≈ 影片總長）。做法完全比照 `video-editor/js/export.js` 的「方案二：MediaRecorder 即時錄製（備援）」（`captureStream`＋`createMediaStreamDestination`＋單一 `MediaRecorder` 貫穿整段，不要每段分開錄再合併——`MediaRecorder` 產生的 webm 沒辦法簡單二進位串接，必須整段用同一個 recorder 實例連續錄到底）。
- **字幕／浮水印**：`ctx.strokeText`+`ctx.fillText` 直接畫在 canvas 上（跟 [[AIvideo_Studio_online]] 的 ffmpeg `drawtext`/`subtitles` 濾鏡概念一致，只是換成 Canvas 2D API 實作），浮水印固定燒「AI Video Studio」、不可關閉，跟 online 版的規則一致。

## 配音代理（worker.js）——為什麼存在、怎麼運作、踩過的坑

**背景**：使用者一開始要求「複製 edge-tts 協定改用 JS 直接呼叫」（跳過整個 Python 後端）。**實測證明這條路在真實瀏覽器裡走不通**：

1. 用 Node 24 的全域 `WebSocket`（undici，行為貼近瀏覽器限制：不能自訂 header）連線微軟這個線上語音服務，被拒絕（code 1006）。
2. 用 `mcp__claude-in-chrome` 開一個**真實 Chrome 分頁**（在使用者已上線的 `m255525.github.io` 網域下），從 console 直接發起同樣的連線，**同樣被拒絕**（code 1006）。
3. 用 Node 的 `ws` 套件（能自訂 header，模擬 Python `edge_tts` 套件送的完整 header 組合，包含關鍵的 `Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold`）連線，**成功**拿到真的語音音檔。

**結論**：微軟這個服務會檢查 `Origin` header，只接受偽裝成特定瀏覽器擴充功能來源的請求；**瀏覽器的 JavaScript 天生不允許自訂 WebSocket 的 Origin header**（沒有任何寫法能繞過，這是瀏覽器最基本的安全設計），所以任何純前端頁面都連不上。這不是我方程式碼的 bug，是無法繞過的架構限制。

**解法**：問使用者要怎麼處理，使用者選了「加一個極簡的免費 serverless 代理」。`worker.js` 部署到 Cloudflare Workers（server-side runtime，不受瀏覽器 Origin 限制，`fetch()` 可以自訂任意 header），照抄 Python `edge_tts` 套件（`C:\Users\mark_\AppData\Roaming\Python\Python314\site-packages\edge_tts\`，尤其 `drm.py`／`communicate.py`）的協定邏輯：

- `generateSecMsGec()`：把目前時間換算成 Windows 檔案時間 tick、無條件捨去到最近的 5 分鐘、跟固定的 `TRUSTED_CLIENT_TOKEN` 字串相接後 SHA-256、轉大寫 hex——這是公開演算法，沒有機密金鑰，純粹是時間雜湊，可以放心寫進公開 repo。
- 連線用 `fetch(url, {headers:{Upgrade:'websocket', ...}})`，`url` 要用 `https://` 不是 `wss://`——**踩坑**：`wrangler dev --local` 本機測試時，`wss://` 會直接噴 `Fetch API cannot load: wss://...`，改用 `https://`+`Upgrade: websocket` header 才能正常觸發 Cloudflare Workers 的 WebSocket 升級機制。
- **⚠️ 最關鍵的踩坑（花最多時間排查）**：二進位 WebSocket 訊息的長度前綴解析寫錯，導致每一段音訊資料開頭少了 2 bytes（正好是 MPEG frame 的同步字元 `0xFF 0xF3`）。症狀：`ffmpeg`／`ffprobe` 對輸出檔案還是能算出合理的時長（因為 ffmpeg 的 mp3 解碼器夠寬容，遇到壞掉的 frame 會往後找下一個同步字元繼續解，過程中狂噴 `Header missing` 但仍完成解碼），**但瀏覽器嚴格的 `decodeAudioData()`／`<audio>` 元件完全拒收、甚至連 `error` 事件都不觸發、直接卡死在 loading 狀態**——這個症狀差異本身就是重要線索：「ffmpeg 能解但瀏覽器完全不吃」通常代表資料流開頭幾個 bytes 有問題，不是中段偶爾的小瑕疵。抓法：拿 Python `edge_tts.Communicate(...).save()` 產生同一段文字的參考檔，`xxd` 逐 byte 比對開頭，發現參考檔以 `ff f3` 開頭、我方輸出直接少了這 2 bytes。根因是把 Python `get_headers_and_data()` 的切片邏輯抄錄時搞錯語意：協定裡「header 長度」這個值**已經把最前面那 2 個長度前綴 byte 算在內**，所以正確切法是 `header = buf.slice(2, headerLen)`、`audio = buf.slice(headerLen + 2)`（`+2` 是 header 區塊跟音訊資料之間的 `\r\n` 分隔符），**不是** `buf.slice(2, 2+headerLen)` / `buf.slice(2+headerLen+2)`（會多切掉 2 bytes）。**下次如果又要移植這類「長度前綴＋文字 header＋二進位酬載」的二進位協定，先找一份公認正確的參考實作輸出，逐 byte diff 開頭，不要只看 ffprobe 說 duration 正常就當作沒事**——ffmpeg 的容錯能力會掩蓋掉這類 off-by-N 錯誤，只有拿嚴格的解碼器（或跟參考實作逐 byte 比對）才驗得出來。
- **修好之後的驗證方式**：本機用 `wrangler dev --local`（不需要登入 Cloudflare 帳號，`workerd` 執行時跟正式環境行為一致）起一個假的 Worker，`curl` 打 `/tts` 拿到 mp3 位元組，`ffmpeg -v error -i out.mp3 -f null -` 確認**零筆** `Header missing`；接著實際開一個真實 Chrome 分頁跑 `<audio>`／`decodeAudioData` 兩種消費方式，確認都能正常讀出 duration。修好前後的具體症狀差異、byte-level 比對過程，是這次除錯最重要的方法論，值得下次遇到類似「二進位協定移植後某些輸入偶爾失敗」時參考。

## 前端配音管線的另一個踩坑：別用 `decodeAudioData`

即使 `worker.js` 的 bug 修好之後，前端原本用 `AudioContext.decodeAudioData()` 把配音解成 `AudioBuffer` 再用 `AudioBufferSourceNode` 播放/錄製——**這個設計本身也是錯的，即使 worker.js 完全正確也不該這樣做**。原因：這個線上語音服務吐出的 mp3 是**逐段串流拼接**而成，各段之間的 frame 邊界偶爾對不齊（這是這個服務正常的特性，Python `edge_tts` 使用者一直都是這樣用、正常播放沒問題），一般播放器與瀏覽器的 `<audio>`/`<video>` 播放管線都容忍這種小瑕疵，但 `decodeAudioData()` 是嚴格、一次性、全有全無的解碼器，只要中間有一小段不齊就整段拒收。**修法**：改用 `new Audio()` 搭配 `createMediaElementSource()`（見 `index.html` 的 `measureAudioDuration()`／`playSegment()` 註解），不要碰 `decodeAudioData`。量測長度也不能靠 `<audio>` 本身的 `loadedmetadata`（blob URL 常有 duration 回報 `Infinity` 的瀏覽器已知小 bug），要用「跳到極大時間點再跳回」的經典 workaround（見程式碼裡的 `measureAudioDuration()`）。

## 已完成的端對端驗證（2026-08-06）

用 `mcp__claude-in-chrome` 開真實 Chrome 分頁（不是 headless/模擬），搭配本機 `wrangler dev --local`（假 Worker）與 `python -m http.server`（假靜態站）跑過完整流程：
1. 解析腳本 → `searchClips()` 直連 Pexels API 拿到候選影片（12 部）
2. `pickClip()` 選片，`clip.url` 是 Pexels CDN 直連連結（無下載步驟）
3. `runTTS()` 透過 Worker 拿到可播放配音（`duration` 正確算出）
4. `runCompose()` 完整跑一次即時錄製，產出 1920×1080 webm blob（~3.8MB）
5. 用 canvas 逐幀分析輸出影片的畫面，確認右下角浮水印區與下方字幕區都有大量白色像素（證實真的燒進畫面，不是只在預覽階段畫過）
6. 用 `AnalyserNode` 量測輸出影片的音訊 RMS（≈0.08，明顯非靜音），確認音軌真的被錄進去

測試後已清空本機測試用的 localStorage 設定、關閉測試伺服器與瀏覽器分頁。

## 待辦

- **`worker.js` 尚未部署到正式 Cloudflare 帳號**，`index.html` 的 `DEFAULT_TTS_WORKER_URL` 常數目前是空字串（fail-closed，比照工作區 `LICENSE_CHECK_URL` 慣例）。使用者需要自己申請免費 Cloudflare 帳號並部署（帳號申請/OAuth 授權這類動作不能由 Claude 代勞），部署後把網址回填到這個常數，或使用者自行在頁面「🔧 語音服務代理網址」欄位填入亦可（設定存 localStorage，不需要改原始碼）。
- **尚未 `git init`／推上 GitHub**。比照 [[aivideo-studio-online-project]] 的模式：在這個資料夾內獨立 `git init`（巢狀 repo，跟外層 `ai-video-studio/` 那個本機用途的 repo 無關），排除規則不需要 `clips/`／`audio/`／`output/`（這個架構完全沒有這些資料夾，全部在記憶體/blob URL），但仍需排除 `node_modules/`（若使用者本機測試 `wrangler` 時產生）與 `.wrangler/`。
- manual.html 的「跟其他版本的差異」小節連結指向 `ai-video-studio-lite`，兩個 repo 之後可以互相連結。

## 指令

`node --check` 抽出的 inline `<script>` 檢查語法；`node --check worker.js` 檢查 Worker 語法。本機測試 Worker：`npx wrangler dev --local`（不需要登入）。本機測試前端：任何靜態伺服器（`python -m http.server`）即可，`file://` 直接開也可以（Pexels／Worker 都是純 `fetch`，沒有 `file://` 下的 CORS 限制問題）。
