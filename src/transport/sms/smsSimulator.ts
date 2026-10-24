import express from 'express';
import { initSchema } from '../../core/db';
import { listPatients } from '../../core/entityStore';
import { handleInboundSms } from '../../modules/sms/smsService';

/**
 * Standalone SMS SIMULATOR web app (patient-facing only).
 *
 * Runs on its own port, separate from the main HMS web app, so it stays a
 * fully optional transport. It renders a phone-style chat UI and exposes a
 * tiny JSON API so you can "text" the clinic and see the replies the SMS
 * module would send. No clinical write access — read + reply only.
 */

const SMS_PORT = Number(process.env.SMS_PORT || 3100);

export function createSmsApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // List the demo "SIM" numbers (patients who have a phone on file) so the UI
  // can offer a dropdown. Names are shown only as a demo convenience.
  app.get('/api/sims', (_req, res) => {
    const sims = listPatients()
      .filter((p) => p.phone)
      .map((p) => ({ phone: p.phone, label: `${p.name} (${p.phone})` }));
    res.json({ sims });
  });

  // Inbound "text": { from, body } -> { reply: string[] }.
  app.post('/sms', (req, res) => {
    const from = String(req.body.from || '');
    const body = String(req.body.body || '');
    if (!from) {
      res.status(400).json({ error: 'Missing "from" phone number.' });
      return;
    }
    const reply = handleInboundSms(from, body);
    res.json({ reply: reply.lines });
  });

  app.get('/', (_req, res) => {
    res.type('html').send(PAGE);
  });

  return app;
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SMS Simulator — Bamboo HMS</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20viewBox%3D%220%200%2032%2032%22%3E%3Crect%20width%3D%2232%22%20height%3D%2232%22%20rx%3D%228%22%20fill%3D%22%230a7d6b%22/%3E%3Crect%20x%3D%2212.5%22%20y%3D%224%22%20width%3D%227%22%20height%3D%227.5%22%20rx%3D%222%22%20fill%3D%22%23fff%22/%3E%3Crect%20x%3D%2212.5%22%20y%3D%2212.5%22%20width%3D%227%22%20height%3D%227.5%22%20rx%3D%222%22%20fill%3D%22%23fff%22/%3E%3Crect%20x%3D%2212.5%22%20y%3D%2221%22%20width%3D%227%22%20height%3D%227%22%20rx%3D%222%22%20fill%3D%22%23fff%22/%3E%3Cpath%20d%3D%22M19.5%2012C23%207.5%2026.5%207%2028.5%207.5C26.5%2011%2023.5%2012.8%2019.5%2012Z%22%20fill%3D%22%239be3c0%22/%3E%3Cpath%20d%3D%22M12.5%2020.5C9%2016%205.5%2015.5%203.5%2016C5.5%2019.5%208.5%2021.3%2012.5%2020.5Z%22%20fill%3D%22%239be3c0%22/%3E%3C/svg%3E" />
<style>
  :root { --accent:#0a7d6b; --line:#dfe6ea; --bg:#eef2f3; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:system-ui,sans-serif; background:var(--bg); color:#1b2a33; }
  .wrap { max-width:460px; margin:24px auto; padding:0 12px; }
  h1 { font-size:18px; }
  .muted { color:#5b7280; font-size:13px; }
  .phone { background:#fff; border:1px solid var(--line); border-radius:18px; overflow:hidden; box-shadow:0 8px 30px rgba(0,0,0,.08); }
  .bar { background:var(--accent); color:#fff; padding:10px 14px; font-weight:600; font-size:14px; }
  .log { height:460px; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:8px; background:#f6f9fa; }
  .msg { max-width:80%; padding:8px 11px; border-radius:14px; font-size:14px; white-space:pre-wrap; line-height:1.35; }
  .out { align-self:flex-end; background:var(--accent); color:#fff; border-bottom-right-radius:4px; }
  .in  { align-self:flex-start; background:#fff; border:1px solid var(--line); border-bottom-left-radius:4px; }
  .composer { display:flex; gap:8px; padding:10px; border-top:1px solid var(--line); background:#fff; }
  .composer input { flex:1; padding:9px 10px; border:1px solid var(--line); border-radius:20px; font-size:14px; }
  .composer button { background:var(--accent); color:#fff; border:0; border-radius:20px; padding:9px 16px; font-size:14px; cursor:pointer; }
  .controls { margin:10px 0; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  select, .chip { font-size:13px; }
  .chip { background:#fff; border:1px solid var(--line); border-radius:14px; padding:4px 10px; cursor:pointer; }
  .chips { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Clinic SMS Simulator</h1>
  <p class="muted">Patient-facing demo. Pick a SIM (phone number), then text the clinic. Try HELP, EHR, MEDS, PHARMACY, HOSPITAL, APPT. After EHR, reply with a number to open an item, or text REC 12 to open record #12.</p>

  <div class="controls">
    <label class="muted">From:</label>
    <select id="sim"></select>
  </div>

  <div class="phone">
    <div class="bar">Clinic SMS &nbsp;·&nbsp; <span id="who" class="muted" style="color:#d7efe9"></span></div>
    <div class="log" id="log"></div>
    <form class="composer" id="form">
      <input id="body" placeholder="Type a message (e.g. MEDS)" autocomplete="off" />
      <button type="submit">Send</button>
    </form>
  </div>

  <div class="chips" id="chips"></div>
</div>

<script>
  const log = document.getElementById('log');
  const sim = document.getElementById('sim');
  const who = document.getElementById('who');
  const form = document.getElementById('form');
  const body = document.getElementById('body');
  const chips = document.getElementById('chips');

  function add(text, cls) {
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  async function loadSims() {
    const r = await fetch('/api/sims');
    const { sims } = await r.json();
    sim.innerHTML = '';
    // Also allow an explicitly unknown number to demo the privacy path.
    const unknown = document.createElement('option');
    unknown.value = '+10000000000';
    unknown.textContent = 'Unknown number (+10000000000)';
    for (const s of sims) {
      const o = document.createElement('option');
      o.value = s.phone; o.textContent = s.label;
      sim.appendChild(o);
    }
    sim.appendChild(unknown);
    who.textContent = sim.value;
  }
  sim.addEventListener('change', () => { who.textContent = sim.value; });

  async function send(text) {
    add(text, 'out');
    const r = await fetch('/sms', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ from: sim.value, body: text })
    });
    const { reply, error } = await r.json();
    if (error) { add(error, 'in'); return; }
    add(reply.join('\\n'), 'in');
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = body.value.trim();
    if (!text) return;
    body.value = '';
    send(text);
  });

  for (const cmd of ['HELP','EHR','MEDS','PHARMACY','HOSPITAL','APPT']) {
    const c = document.createElement('span');
    c.className = 'chip'; c.textContent = cmd;
    c.onclick = () => send(cmd);
    chips.appendChild(c);
  }

  loadSims();
</script>
</body>
</html>`;

if (require.main === module) {
  initSchema();
  const app = createSmsApp();
  app.listen(SMS_PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`SMS simulator running at http://localhost:${SMS_PORT}`);
    console.log('Open it in a browser, pick a SIM, and text HELP / EHR / MEDS / PHARMACY / HOSPITAL / APPT.');
  });
}
