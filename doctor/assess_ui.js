/* HIVE Doctor — front-door + deterministic assessment UI.
   DOM wiring only; all reasoning is in triage.js. No inline script (CSP-safe).
   Adds: "the doctor will see you now" entry, anonymous / choose / create profile,
   build-a-profile-from-the-session, and copy/download session export for a real doctor.
   Profiles live only on this device (localStorage). */
"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const log = $("log"), form = $("form"), q = $("q"), status = $("status");
  const PK = "hive.profiles", AK = "hive.active", ACK = "hive.ai.ack", MK = "hive.mode";
  const VERSION = "v116";
  let ready = false, pendingSave = "";  // "new" | "session"
  let mode = (function () { try { return localStorage.getItem(MK) === "chat" ? "chat" : "standard"; } catch (e) { return "standard"; } })();

  // ---------- optional conversational layer (local model, safety-locked) ----------
  // Rewords ONLY a short plain-language summary of the deterministic result. It
  // never alters the clinical breakdown or the locked safety note, never invents
  // numbers, and falls back to the deterministic sentence if the model is
  // unreachable or tries to drift. Endpoint is a local HIVE model (offline).
  const AI_URL = "http://127.0.0.1:11434/api/generate";
  // Qwen Assist server endpoint (present only when the app is launched from
  // assist/qwen_server.js). Same-origin; absent on the static site / phone PWA.
  const ASSIST_URL = "/assist"; let assistReady = false;
  let integrity = null;   // {ok:true|false|null} from HIVEIntegrity — content-addressed forged/stale check
  const AI_MODEL = "hive-local-qwen3-8b:latest";
  const AI_SYS = "You are the spoken-style summary voice of a medical TRIAGE tool speaking to a worried person. " +
    "Rewrite the status sentence to sound calm, clear and professional. STRICT RULES: do not add any medical advice, " +
    "instructions, actions, diagnoses, symptoms, or new numbers. Do not tell them what to do. Keep the same meaning and " +
    "the same triage grade number. One or two short sentences. Output only the sentence.";
  // Words the rewording must not INTRODUCE unless they were already in the
  // source sentence: directives/clinical terms AND urgency/severity injectors
  // (a small model loves to add "immediate"/"urgent" to a mild grade).
  const AI_BANNED = /\b(call|911|999|112|ambulance|hospital|a&e|aspirin|medication|dose|take|stop|avoid|rest|lie down|heart attack|stroke|clot|sepsis|cancer|diagnos\w*|immediate|immediately|urgent|urgently|emergency|asap|prompt|promptly|severe|critical|life-?threatening|dangerous|right away)\b/gi;

  function plainBase(html) {
    const gm = html.match(/Score\s+(\d+)\/100/);
    const lm = html.match(/Severity\s+\d+\/10\s*&mdash;\s*([A-Za-z]+)/);
    const emergency = /blk emerg/.test(html);
    if (!gm || !lm) return "";
    const score = gm[1], label = lm[1].toLowerCase();
    if (emergency)
      return "In plain terms: based on what you've described, this needs prompt attention — a triage grade of " + score +
        " out of 100. Please read the safety note below. This is guidance, not a diagnosis.";
    return "In plain terms: based on what you've described, this looks " + label + " for now — a triage grade of " +
      score + " out of 100. This is guidance, not a diagnosis.";
  }
  // Guard: accept a rewording only if it stays faithful; else keep the exact
  // deterministic sentence. Same rule whichever model produced it.
  function applyGuards(sentence, out) {
    out = (out || "").replace(/\s+/g, " ").trim().replace(/^"|"$/g, "");
    if (!out || out.length > 260) return sentence;
    const src = sentence.toLowerCase(); let m; AI_BANNED.lastIndex = 0;
    while ((m = AI_BANNED.exec(out))) { if (src.indexOf(m[0].toLowerCase()) < 0) return sentence; }
    const ns = new Set(sentence.match(/\d+/g) || []); const no = new Set(out.match(/\d+/g) || []);
    for (const n of no) if (!ns.has(n)) return sentence;   // invented a number
    return out;
  }

  // On-device model (phone GPU) via the self-hosted MLC WebLLM runtime — the
  // same engine ai.js uses. Loaded once (one-time download), then fully offline.
  let llm = null, llmLoading = false, llmTried = false;
  async function ensureLocalLLM() {
    if (llm || llmLoading || llmTried) return llm;
    if (!("gpu" in navigator)) { llmTried = true; return null; }   // no WebGPU → stay on fallback
    llmLoading = true;
    try {
      // Load the WebLLM runtime: self-hosted copy if present, else a pinned CDN
      // (first load needs internet; model + runtime then cache for offline use).
      let webllm;
      try { webllm = await import("./web-llm.js"); }
      catch (e) { webllm = await import("https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.79/+esm"); }
      const list = (webllm.prebuiltAppConfig && webllm.prebuiltAppConfig.model_list) || [];
      const pick = list.find(m => /Qwen2\.5-0\.5B-Instruct-q4f16/.test(m.model_id))
        || list.find(m => m.model_id.includes("0.5B") && m.model_id.includes("q4f16"))
        || (list[0] && list[0].model_id);
      const id = pick && (pick.model_id || pick);
      if (!id) { llmTried = true; llmLoading = false; return null; }
      toast("Preparing on-device AI… first time downloads once, then offline");
      llm = await webllm.CreateMLCEngine(id, {
        initProgressCallback: (p) => { if (status) status.textContent = (p && p.text) ? ("On-device AI: " + p.text) : "On-device AI loading…"; }
      });
      toast("On-device AI ready — conversational wording runs on this phone");
      setStatus();
    } catch (e) { llm = null; }   // any failure → deterministic fallback stands
    llmLoading = false; llmTried = true;
    return llm;
  }
  async function llmReword(sentence) {
    try {
      const r = await llm.chat.completions.create({
        messages: [{ role: "system", content: AI_SYS }, { role: "user", content: sentence }],
        temperature: 0.4, max_tokens: 90, stream: false
      });
      return applyGuards(sentence, r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content);
    } catch (e) { return sentence; }
  }
  async function ollamaReword(sentence) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(AI_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: AI_MODEL, system: AI_SYS, prompt: sentence, stream: false, options: { temperature: 0.4, num_predict: 90 } }),
        signal: ctrl.signal
      });
      clearTimeout(t);
      if (!r.ok) return sentence;
      const j = await r.json();
      return applyGuards(sentence, j.response);
    } catch (e) { return sentence; }
  }
  // On-device UNDERSTANDING: Qwen rewrites messy wording into a plain symptom
  // description that the deterministic engine routes better. Never trusted as an
  // answer — it only feeds the engine. Falls back to the raw text on any issue.
  const UNDERSTAND_SYS = "Rewrite the person's health message into a short, plain description of symptoms and context for a triage tool. Keep every concrete detail: body part, how long, what it feels like, any medicines named, age. Do NOT diagnose, do NOT add advice, do NOT invent anything. Reply with the rewritten description only.";
  async function understandLocal(text) {
    if (!llm) return text;
    try {
      const r = await llm.chat.completions.create({
        messages: [{ role: "system", content: UNDERSTAND_SYS }, { role: "user", content: text }],
        temperature: 0, max_tokens: 140, stream: false
      });
      const out = (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content || "").trim();
      return (out && out.length < 500) ? out : text;
    } catch (e) { return text; }
  }
  // Order: on-device phone model → desktop local model → deterministic fallback.
  async function rewordLocal(sentence) {
    if (llm) return await llmReword(sentence);
    const viaOllama = await ollamaReword(sentence);
    if (viaOllama !== sentence) return viaOllama;
    return sentence;
  }

  // iOS standalone-PWA keyboard fix: pin the app to the visible area above the
  // keyboard using the visualViewport, and keep the window scrolled to the top so
  // the header never slides under the status bar.
  (function keyboardFit() {
    var vv = window.visualViewport; if (!vv) return;
    function fit() {
      var h = Math.round(vv.height);
      document.documentElement.style.height = h + "px";
      document.body.style.height = h + "px";
      if (window.pageYOffset) window.scrollTo(0, 0);
    }
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    window.addEventListener("orientationchange", function () { setTimeout(fit, 300); });
    fit();
  })();

  // ---------- small helpers ----------
  function esc(s) { return (s || "").replace(/[&<>]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m])); }
  function add(role, html) {
    const d = document.createElement("div");
    d.className = "msg " + role;
    d.innerHTML = '<div class="who">' + (role === "you" ? "You" : "HIVE Doctor") + '</div><div class="txt">' + html + "</div>";
    log.appendChild(d); log.scrollTop = log.scrollHeight;
    return d;
  }
  function toast(msg) {
    const t = $("toast"); if (!t) return;
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 1900);
  }
  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { } }
  function profiles() { try { return JSON.parse(lsGet(PK, "{}")) || {}; } catch (e) { return {}; } }
  function saveProfiles(o) { lsSet(PK, JSON.stringify(o)); }
  function activeName() { return lsGet(AK, ""); }

  // ---------- profile apply / snapshot ----------
  function snapshot() {
    const p = (window.HIVETriage && HIVETriage._state && HIVETriage._state.profile) || {};
    return JSON.parse(JSON.stringify(p));
  }
  function applyProfile(name) {
    HIVETriage.reset(); log.innerHTML = "";
    const all = profiles();
    if (name && all[name]) { HIVETriage.setProfile(JSON.parse(JSON.stringify(all[name]))); lsSet(AK, name); }
    else { lsDel(AK); name = ""; }
    greet(name);
    setStatus();
  }
  function mergeInto(name, prof) {
    const all = profiles(); const cur = all[name] || {};
    for (const k in prof) {
      if (prof[k] == null) continue;
      if (Array.isArray(prof[k])) { cur[k] = Array.from(new Set((cur[k] || []).concat(prof[k]))); }
      else cur[k] = prof[k];
    }
    all[name] = cur; saveProfiles(all); lsSet(AK, name);
  }

  function setStatus() {
    const n = (HIVETriage._state.map && HIVETriage._state.map.counts) ? HIVETriage._state.map.counts : { conditions: 0, symptoms: 0 };
    const who = activeName() ? ("Profile: " + activeName()) : "Anonymous";
    const styleLbl = (mode === "chat" ? "Conversational" : "Standard");
    const integ = integrity ? (integrity.ok === true ? " · ✓ verified" : integrity.ok === false ? " · ⚠ integrity" : "") : "";
    status.textContent = who + " · " + styleLbl + (assistReady ? " · Qwen Assist" : "") + integ + " · private · works offline · " + VERSION;
  }
  function updateModeBtn() {
    const b = $("modebtn"); if (!b) return;
    const on = mode === "chat";
    b.textContent = on ? "◼" : "◻";
    b.title = on
      ? "Response style: Conversational (local AI phrasing; safety note always exact). Tap for Standard."
      : "Response style: Standard (deterministic). Tap for Conversational.";
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }
  function greet(name) {
    const hi = name ? ("Hello " + esc(name) + ". ") : "";
    add("bot", hi + "Tell me what's going on — the main problem, where it is, when it started, and how it feels. You can describe more than one thing, list medicines you take, or ask about a condition or treatment. I'll line up the most likely causes, how urgent each is, and what to do." +
      "<div class=\"foot\">You can skip any question — just say “pass”. Here to help you understand and decide, not to replace your doctor. Emergency? Call 911 / 112 / 999.</div>");
  }

  // ---------- front door ----------
  const door = $("ack");
  function renderDoor() {
    const all = profiles(); const names = Object.keys(all);
    const box = $("doorprofiles"); if (!box) return;
    if (!names.length) { box.innerHTML = ""; return; }
    box.innerHTML = '<div class="doorlabel">Continue as…</div>' +
      names.map(n => '<button class="profchip" data-prof="' + esc(n) + '">' + esc(n) + "</button>").join("");
    box.querySelectorAll("button[data-prof]").forEach(b =>
      b.addEventListener("click", () => { applyProfile(b.getAttribute("data-prof")); openDoctor(); }));
  }
  function openDoctor() { lsSet(ACK, "1"); door.classList.add("hidden"); if (!log.children.length) greet(activeName()); q && q.focus(); }
  function showDoor() { renderDoor(); door.classList.remove("hidden"); }

  // ---------- sheets (share + profiles) ----------
  function hideSheets() { $("sharesheet").classList.add("hidden"); $("profsheet").classList.add("hidden"); }
  function openShare() {
    $("sharetext").value = HIVETriage.summary();
    $("sharesheet").classList.remove("hidden");
  }
  function renderProfList() {
    const all = profiles(); const names = Object.keys(all); const act = activeName();
    const box = $("proflist");
    box.innerHTML = names.length ? names.map(n =>
      '<div class="profrow"><span>' + esc(n) + (n === act ? ' <b class="act">· in use</b>' : "") + "</span>" +
      '<span><button class="mini" data-use="' + esc(n) + '">Use</button><button class="mini del" data-del="' + esc(n) + '">Delete</button></span></div>').join("")
      : '<p class="muted">No saved profiles yet. Build one from this session below.</p>';
    box.querySelectorAll("button[data-use]").forEach(b => b.addEventListener("click", () => { applyProfile(b.getAttribute("data-use")); hideSheets(); toast("Loaded profile"); }));
    box.querySelectorAll("button[data-del]").forEach(b => b.addEventListener("click", () => { const o = profiles(); const n = b.getAttribute("data-del"); delete o[n]; saveProfiles(o); if (activeName() === n) lsDel(AK); renderProfList(); setStatus(); toast("Deleted"); }));
  }
  function openProfiles() { renderProfList(); $("namerow").classList.add("hidden"); pendingSave = ""; $("profsheet").classList.remove("hidden"); }

  // ---------- wiring ----------
  const ackbtn = $("startbtn"), info = $("info");
  if (ackbtn) ackbtn.addEventListener("click", () => { lsDel(AK); openDoctor(); setStatus(); });  // start fresh/anonymous
  const anonbtn = $("anonbtn"); if (anonbtn) anonbtn.addEventListener("click", () => { applyProfile(""); openDoctor(); });
  const newprofbtn = $("newprofbtn"); if (newprofbtn) newprofbtn.addEventListener("click", () => { door.classList.add("hidden"); lsSet(ACK, "1"); if (!log.children.length) greet(""); openProfiles(); $("namerow").classList.remove("hidden"); pendingSave = "new"; $("profname").focus(); });
  if (info) info.addEventListener("click", showDoor);
  const modebtn = $("modebtn");
  if (modebtn) modebtn.addEventListener("click", () => {
    mode = (mode === "chat") ? "standard" : "chat";
    lsSet(MK, mode); updateModeBtn(); setStatus();
    if (mode !== "chat") { toast("Standard wording"); return; }
    toast("Conversational wording on — the safety note stays exact");
    // Offer on-device phone AI (one-time download) if the phone supports it and
    // no model is loaded yet. Declining still gives the professional summary.
    if (!llm && !llmLoading && !llmTried && ("gpu" in navigator)) {
      const ok = window.confirm(
        "Run conversational wording on THIS phone, offline?\n\n" +
        "It downloads a small on-device AI model once (a few hundred MB over Wi-Fi), " +
        "then works with no internet. The medical assessment and the safety note are " +
        "never changed by it.\n\nDownload now?");
      if (ok) ensureLocalLLM();
    }
  });
  updateModeBtn();

  const profbtn = $("profbtn"); if (profbtn) profbtn.addEventListener("click", openProfiles);
  const sharebtn = $("sharebtn"); if (sharebtn) sharebtn.addEventListener("click", openShare);

  // share sheet
  $("sharecancel").addEventListener("click", hideSheets);
  $("copybtn").addEventListener("click", () => {
    const txt = $("sharetext").value;
    const done = () => toast("Copied — paste it anywhere");
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done).catch(() => { $("sharetext").select(); try { document.execCommand("copy"); done(); } catch (e) { toast("Select and copy the text"); } });
    else { $("sharetext").select(); try { document.execCommand("copy"); done(); } catch (e) { toast("Select and copy the text"); } }
  });
  $("dlbtn").addEventListener("click", () => {
    const d = new Date(), p = n => (n < 10 ? "0" : "") + n;
    const fn = "hive-doctor-session-" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + ".txt";
    const blob = new Blob([$("sharetext").value], { type: "text/plain" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fn;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    toast("Saved " + fn);
  });
  $("savesessbtn").addEventListener("click", () => { hideSheets(); openProfiles(); $("namerow").classList.remove("hidden"); pendingSave = "session"; $("profname").focus(); });

  // profile sheet
  $("profcancel").addEventListener("click", hideSheets);
  $("profnew").addEventListener("click", () => { $("namerow").classList.remove("hidden"); pendingSave = "session"; $("profname").focus(); });
  $("profsave").addEventListener("click", () => {
    const name = ($("profname").value || "").trim(); if (!name) { toast("Give it a name"); return; }
    mergeInto(name, snapshot());             // create or add-to-existing (merge)
    $("profname").value = ""; $("namerow").classList.add("hidden");
    renderProfList(); setStatus(); toast("Saved to “" + name + "”");
  });

  // offline badge
  const off = $("offbadge");
  function setOff() { if (!off) return; const on = navigator.onLine; off.textContent = on ? "● Ready" : "● Offline"; off.title = on ? "Runs on your device; no connection needed" : "No connection — running fully on your device"; }
  window.addEventListener("online", setOff); window.addEventListener("offline", setOff); setOff();

  // ---------- load engine ----------
  HIVETriage.load().then(() => {
    ready = true;
    // apply active profile if one is set
    const an = activeName(); const all = profiles();
    if (an && all[an]) HIVETriage.setProfile(JSON.parse(JSON.stringify(all[an])));
    setStatus();
    renderDoor();
    // first run shows the door; afterwards go straight in
    if (lsGet(ACK, "") === "1") { door.classList.add("hidden"); greet(activeName()); q && q.focus(); }
    // Verify the knowledge base against its content-addressed manifest (AtomStore/
    // ARK1 forged/stale rejection). Non-blocking; surfaced in the status line.
    (async () => {
      try { if (window.HIVEIntegrity) { integrity = await HIVEIntegrity.verify(); setStatus(); } } catch (e) { }
    })();
    // Probe for the Qwen Assist server (no model call: understand/converse off).
    (async () => {
      try {
        const r = await fetch(ASSIST_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "", understand: false, converse: false }) });
        if (r.ok) { const j = await r.json(); assistReady = !!(j && j.authoritative); }
      } catch (e) { assistReady = false; }
      setStatus();
    })();
  }).catch(() => { status.textContent = "Could not load the knowledge base. Check your connection and reload."; });

  // ---------- chat ----------
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const text = (q.value || "").trim();
    if (!text || !ready) return;
    const youNode = add("you", esc(text));
    q.value = "";
    // Qwen Assist (only when launched from qwen_server.js): Qwen cleans up the
    // wording so the engine routes better, and writes a verified intro. The engine
    // still produces the grounded, cited answer below. Falls back on any error.
    let engineInput = text, serverIntro = null;
    if (assistReady) {
      // Launched from the Qwen Assist server (PC): Qwen understands + writes a verified intro.
      try {
        const r = await fetch(ASSIST_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: text, understand: true, converse: mode === "chat" }) });
        if (r.ok) { const j = await r.json(); if (j && j.normalized_query) engineInput = j.normalized_query; if (j && j.assist_intro) serverIntro = j.assist_intro; }
      } catch (e) { }
    } else if (llm && mode === "chat") {
      // On the phone (no server): the on-device Qwen understands the wording.
      engineInput = await understandLocal(text);
    }
    const html = HIVETriage.turn(engineInput);
    const node = add("bot", html);
    // Conversational mode: prepend a plain-language summary above the full
    // deterministic breakdown. The clinical blocks and the locked safety note
    // below are never changed. Falls back silently if the local model is off.
    let pt = null, base = "";
    if (mode === "chat") {
      base = serverIntro || plainBase(html);   // prefer Qwen's server-verified intro
      if (base) {
        const txt = node.querySelector(".txt");
        pt = document.createElement("div");
        pt.className = "blk plainterms";
        pt.style.cssText = "border-left:3px solid currentColor;padding-left:10px;opacity:.95";
        pt.innerHTML = '<div class="htag">In plain terms</div><p>' + esc(base) + "</p>";
        txt.insertBefore(pt, txt.firstChild);
      }
    }
    // Anchor the new exchange: put the person's question at the top so the whole
    // answer is read top-down and is never hidden behind the composer.
    anchorExchange(youNode);
    setStatus();
    // Then (if on) let the on-device model warm the wording — layout already settled.
    if (pt && base && !serverIntro) {   // server intro is already verified; skip local reword
      try {
        const worded = await rewordLocal(base);
        if (worded && worded !== base) pt.querySelector("p").textContent = worded;
      } catch (e) { }
    }
  });

  // Scroll so the given (newest) question sits at the top of the chat area, with
  // its answer flowing below — the standard messaging pattern. Falls back to a
  // plain bottom-scroll if anything is off.
  function anchorExchange(youNode) {
    try {
      requestAnimationFrame(() => {
        if (youNode && youNode.scrollIntoView) youNode.scrollIntoView({ block: "start", behavior: "smooth" });
        else log.scrollTop = log.scrollHeight;
      });
    } catch (e) { log.scrollTop = log.scrollHeight; }
  }

  const reset = $("reset");
  if (reset) reset.addEventListener("click", () => {
    HIVETriage.reset();
    const an = activeName(); const all = profiles();
    if (an && all[an]) HIVETriage.setProfile(JSON.parse(JSON.stringify(all[an])));  // keep the chosen profile
    log.innerHTML = ""; greet(activeName()); setStatus(); q && q.focus();
  });

  // register the service worker so the Doctor works offline when installed.
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    try { navigator.serviceWorker.register("./sw.js"); } catch (e) { }
  }
})();
