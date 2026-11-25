# AI 影音工坊（純瀏覽器版）

[![Hits](https://hits.sh/github.com/M255525/ai-video-studio-play.svg)](https://hits.sh/github.com/M255525/ai-video-studio-play/)

打開網頁就能玩的 AI 影片製作工具——用 **Pexels 免費影庫**畫面配上**線上語音配音**與**字幕**，一站合成短影片。**沒有後端伺服器**，影片搜尋、下載、合成通通在你的瀏覽器裡完成。

---

## 線上試玩

打開 `index.html`（或部署後的 GitHub Pages 網址）即可使用，不需要安裝、不需要帳號（除了免費申請的 Pexels 金鑰）。

## 流程

1. **腳本** — 一行一段輸入字幕文字與英文搜尋關鍵字
2. **選片** — 直接向 Pexels 搜尋免費影片素材（瀏覽器直連，無需後端）
3. **配音** — 用自己的語音服務金鑰產生口白，或自己錄音／上傳音檔
4. **合成** — 瀏覽器即時播放＋錄製成影片（`MediaRecorder` + `canvas`），可燒字幕，右下角固定燒錄浮水印

---

## 語音服務

`tts.js` 只呼叫各家公開的官方 API（Google Gemini／OpenAI／ElevenLabs），使用者自備金鑰、瀏覽器直接連線；也可以每段自己錄音或上傳音檔。2026-11-25 起移除原本的語音代理。

---

## 授權與使用範圍

影片素材來自 [Pexels](https://www.pexels.com)，依 Pexels 授權條款免費使用（禁止原封不動轉售素材本身）。自動配音依所選語音服務的條款使用，發布時請讓觀眾知道哪些是 AI 合成語音。

創作者：蔡豐全（Mark Tsai） · tsaimark@gmail.com
