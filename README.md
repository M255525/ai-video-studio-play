# AI 影音工坊（純瀏覽器版）

[![Hits](https://hits.sh/github.com/M255525/ai-video-studio-play.svg)](https://hits.sh/github.com/M255525/ai-video-studio-play/)

打開網頁就能玩的 AI 影片製作工具——用 **Pexels 免費影庫**畫面配上**線上語音配音**與**字幕**，一站合成短影片。**沒有後端伺服器**（除了一個極輕量、只負責轉發配音請求的代理），影片搜尋、下載、合成通通在你的瀏覽器裡完成。

---

## 線上試玩

打開 `index.html`（或部署後的 GitHub Pages 網址）即可使用，不需要安裝、不需要帳號（除了免費申請的 Pexels 金鑰）。

## 流程

1. **腳本** — 一行一段輸入字幕文字與英文搜尋關鍵字
2. **選片** — 直接向 Pexels 搜尋免費影片素材（瀏覽器直連，無需後端）
3. **配音** — 透過一個輕量代理取得線上語音口白
4. **合成** — 瀏覽器即時播放＋錄製成影片（`MediaRecorder` + `canvas`），可燒字幕，右下角固定燒錄浮水印

---

## 架構：為什麼需要一個「代理」

這個工具幾乎整個都在瀏覽器裡完成，**除了配音這一步**。線上語音合成服務會檢查連線來源（`Origin` header），而瀏覽器基於安全設計不允許 JavaScript 偽造這個 header，導致網頁沒辦法直接連上去要配音。`worker.js` 是解法：一個跑在 [Cloudflare Workers](https://workers.cloudflare.com/) 免費方案上的極簡代理，唯一的工作是幫網頁把配音請求轉發出去、把結果原封不動送回來——不儲存任何內容，也不需要資料庫。

### 部署你自己的代理（可選，作者已提供預設代理）

```bash
npm install -g wrangler
wrangler login
cd AIvideo_Studio_web
wrangler deploy
```

部署完成後會拿到一個 `https://xxx.workers.dev` 網址，貼到頁面「03 配音」的「🔧 語音服務代理網址」欄位即可（設定只存在你的瀏覽器）。

---

## 授權與使用範圍

影片素材來自 [Pexels](https://www.pexels.com)，依 Pexels 授權條款免費使用（禁止原封不動轉售素材本身）。配音為線上制式聲音，非真人聲音克隆。

創作者：蔡豐全（Mark Tsai） · tsaimark@gmail.com
