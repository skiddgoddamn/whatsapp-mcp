import http from "node:http";
import QRCode from "qrcode";
import open from "open";
import type P from "pino";

// Serves the pairing QR on a local page that auto-refreshes the image on every
// ~20s Baileys rotation and flips to a "connected" state once paired. Beats a
// static PNG (never stale) and never sends the pairing token off-machine.

type QrStatus = "waiting" | "pending" | "open";

const HOST = "127.0.0.1";
const PORT = Number(process.env.WHATSAPP_QR_PORT ?? 5188);

let latestQr: string | null = null;
let status: QrStatus = "waiting";
let server: http.Server | null = null;
let browserOpened = false;

const PAGE = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp MCP — привязка</title>
<style>
  :root{color-scheme:dark}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b141a;
    color:#e9edef;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{background:#111b21;padding:32px 36px;border-radius:18px;text-align:center;
    box-shadow:0 12px 48px #0009;max-width:400px}
  h1{font-size:18px;font-weight:600;margin:0 0 20px}
  .frame{width:320px;height:320px;margin:0 auto;background:#fff;border-radius:14px;
    display:flex;align-items:center;justify-content:center;overflow:hidden}
  .frame img{width:296px;height:296px}
  .ok{font-size:64px;line-height:320px}
  .st{color:#8696a0;font-size:14px;margin:18px 0 0}
  .hint{color:#8696a0;font-size:12px;margin:8px 0 0}
</style></head>
<body><div class="card">
  <h1>WhatsApp → Настройки → Связанные устройства → Привязка устройства</h1>
  <div class="frame" id="frame"><span class="st">Ожидание QR…</span></div>
  <p class="st" id="st">Ожидание QR…</p>
  <p class="hint">QR обновляется автоматически. Вкладку можно закрыть после подключения.</p>
</div>
<script>
async function tick(){
  try{
    const s = await (await fetch('/state',{cache:'no-store'})).json();
    const frame = document.getElementById('frame');
    const st = document.getElementById('st');
    if(s.status==='open'){
      frame.innerHTML='<div class="ok">✅</div>';
      st.textContent='Подключено — можно закрыть вкладку.';
      return; // stop polling
    }
    if(s.hasQr){
      frame.innerHTML='<img alt="QR" src="/qr.png?t='+Date.now()+'">';
      st.textContent='QR активен, обновляется каждые ~20 сек.';
    } else {
      st.textContent='Ожидание QR…';
    }
  }catch(e){}
  setTimeout(tick,1500);
}
tick();
</script></body></html>`;

function ensureServer(logger: P.Logger): void {
  if (server) return;
  server = http.createServer(async (req, res) => {
    const route = (req.url ?? "/").split("?")[0];
    if (route === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
    } else if (route === "/state") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ status, hasQr: !!latestQr }));
    } else if (route === "/qr.png") {
      if (!latestQr) {
        res.writeHead(204);
        res.end();
        return;
      }
      try {
        const buf = await QRCode.toBuffer(latestQr, { width: 320, margin: 1 });
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(buf);
      } catch (e) {
        res.writeHead(500);
        res.end();
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.on("error", (e) => logger.warn({ err: e }, "QR web server error (port busy?)"));
  server.listen(PORT, HOST, () =>
    logger.info(`QR page live at http://${HOST}:${PORT}`)
  );
}

/** Called on every Baileys `qr` event. Updates the live page + opens it once. */
export function showQr(qr: string, logger: P.Logger): void {
  latestQr = qr;
  status = "pending";
  ensureServer(logger);
  if (!browserOpened) {
    browserOpened = true;
    open(`http://${HOST}:${PORT}`).catch(() => {});
  }
}

/** Called once the socket reaches `connection === "open"`. */
export function qrConnected(logger: P.Logger): void {
  status = "open";
  latestQr = null;
  // Keep the page up briefly so the browser can show the success state, then
  // free the port.
  setTimeout(() => {
    server?.close();
    server = null;
    browserOpened = false;
    status = "waiting";
  }, 30_000);
}
