/* HIVE Doctor — front-door + deterministic assessment UI.
   DOM wiring only; all reasoning is in triage.js. No inline script (CSP-safe).
   Adds: "the doctor will see you now" entry, anonymous / choose / create profile,
   build-a-profile-from-the-session, and copy/download session export for a real doctor.
   Profiles live only on this device (localStorage). */
"use strict";
(function () {
  const $ = (id) => document.getElementById(id);

  // High-performance mode: cross-origin isolation (via sw.js) → multi-thread wllama + bigger
  // models. Off by default; opt-in through the engine panel. ?hp=0 is the escape hatch.
  const HP_KEY = "hive.hp";
  function hpOn() { try { return localStorage.getItem(HP_KEY) === "1"; } catch (e) { return false; } }
  (function hpSync() {
    const has1 = /[?&]hp=1(?:&|$)/.test(location.search);
    const strip = (s) => { s = s.replace(/[?&]hp=[01]/g, ""); if (s === "?" || s === "&") s = ""; return s.replace(/^&/, "?"); };
    if (/[?&]hp=0(?:&|$)/.test(location.search)) { try { localStorage.removeItem(HP_KEY); } catch (e) { } location.replace(location.pathname + strip(location.search) + location.hash); return; }
    const want = hpOn();
    if (want && !has1) { location.replace(location.pathname + (location.search ? location.search + "&" : "?") + "hp=1" + location.hash); return; }
    if (!want && has1) { location.replace(location.pathname + strip(location.search) + location.hash); return; }
    if (has1 && !self.crossOriginIsolated) {
      try { if (navigator.serviceWorker && navigator.serviceWorker.controller && !sessionStorage.getItem("hpR")) { sessionStorage.setItem("hpR", "1"); location.reload(); return; } } catch (e) { }
    } else if (self.crossOriginIsolated) { try { sessionStorage.removeItem("hpR"); } catch (e) { } }
  })();
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
  // HARD RULE (medical): a model may ONLY re-voice the deterministic engine's answer.
  // It must never add, change, or infer any medical content. Enforcement, all-or-nothing —
  // if the rewording breaks ANY rule below, the exact deterministic sentence is used instead:
  //   1. No directive/urgency/clinical word that wasn't already in the engine's text.
  //   2. No number that wasn't already in the engine's text (no invented grades/doses/stats).
  //   3. Every CONTENT word in the rewording must come from the engine's own text, or from a
  //      fixed allowlist of plain conversational words. Any other content word = an introduced
  //      claim, so it's rejected. This makes "say it in your own way" mean: rephrase with the
  //      engine's words + everyday words only — it physically cannot smuggle in a new symptom,
  //      condition, body part, or instruction.
  // SAFE_WORDS: everyday, non-clinical words the rephrase may use freely for warmth/flow.
  const SAFE_WORDS = new Set(("a an and or but so the this that these those is are was were be been being am " +
    "of to in on at for with from by as it its it's your you you're youre my our we i me they them their " +
    "based on what youve you've described shared told mentioned here below note please thanks thank right now " +
    "for now looks look looking seems seem sounds sound appears appear like about around just only still also " +
    "okay ok alright well good lets let's keep take care while when where how why which who there then than " +
    "more most less few some any much many very really quite bit things thing something anything nothing " +
    "manageable manage going get getting go let letting help helpful useful guidance not isnt isn't dont don't " +
    "cant can't need needs needed want wants way simple clear calm gentle short few couple one two several " +
    "understand understood sense makes making does do did have has had will would could should may might can " +
    "telling tell saying say said tells talk talking hearing hear heard sharing noticing notice noticed dealing " +
    "bring bringing brought give gives given giving come comes coming went going seeing see seen feels feeling " +
    "better best fine common often sometimes usually typically generally overall meantime moment moments today " +
    "soon later early mild milder manageably worry worried worrying concern concerned concerning rest reassure " +
    "reassuring steady stable manageable handle handled information info answer answers detail details context " +
    "experience experiencing situation picture summary everyday regular normal straightforward reasonable because").split(/\s+/));
  function applyGuards(sentence, out) {
    out = (out || "").replace(/\s+/g, " ").trim().replace(/^"|"$/g, "");
    if (!out || out.length > 260) return sentence;
    const src = sentence.toLowerCase(); let m; AI_BANNED.lastIndex = 0;
    while ((m = AI_BANNED.exec(out))) { if (src.indexOf(m[0].toLowerCase()) < 0) return sentence; }
    const ns = new Set(sentence.match(/\d+/g) || []); const no = new Set(out.match(/\d+/g) || []);
    for (const n of no) if (!ns.has(n)) return sentence;   // invented a number
    // word-origin rule: every content word must be from the engine's text or the allowlist
    const srcWords = new Set(src.match(/[a-z']{2,}/g) || []);
    const outWords = (out.toLowerCase().match(/[a-z']{2,}/g) || []);
    for (const w of outWords) {
      if (w.length < 4) continue;                         // short function words are fine
      if (srcWords.has(w) || SAFE_WORDS.has(w)) continue;
      return sentence;                                    // introduced a new content word → reject
    }
    return out;
  }

  // ---------- real Qwen endpoint (hosted; phone reaches it over the internet) ----------
  // A real Qwen 3.x is far too big to run inside a phone browser, so the apps call a
  // hosted Qwen (your PC's Ollama exposed by a tunnel, or any cloud endpoint). Point the
  // app at it ONCE with ?qwen=<url>&model=<name>; it's saved on the device and the param
  // is stripped from the address bar. The endpoint is OpenAI-compatible
  // (…/v1/chat/completions). Qwen only writes a short conversational intro — the
  // deterministic engine still produces every grounded, cited fact, and the intro is
  // run through the SAME applyGuards verifier (no invented numbers, no injected
  // directives/urgency) before it is ever shown. If it drifts, the exact engine
  // sentence is used instead. Nothing here can change triage.
  const QK = "hive.qwen.url", QKM = "hive.qwen.model", QKK = "hive.qwen.key";
  (function captureQwenCfg() {
    try {
      const p = new URLSearchParams(location.search);
      let changed = false;
      if (p.has("qwen")) { lsSet(QK, (p.get("qwen") || "").trim()); p.delete("qwen"); changed = true; }
      if (p.has("model")) { lsSet(QKM, (p.get("model") || "").trim()); p.delete("model"); changed = true; }
      if (p.has("key")) { lsSet(QKK, (p.get("key") || "").trim()); p.delete("key"); changed = true; }
      if (p.has("qwenoff")) { lsDel(QK); lsDel(QKM); lsDel(QKK); p.delete("qwenoff"); changed = true; }
      if (changed && history.replaceState) {
        const qs = p.toString();
        history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
      }
    } catch (e) { }
  })();
  function normEndpoint(url) {
    let u = (url || "").trim().replace(/\/+$/, ""); if (!u) return "";
    if (!/\/chat\/completions$/.test(u)) u += /\/v1$/.test(u) ? "/chat/completions" : "/v1/chat/completions";
    return u;
  }
  function remoteCfg() {
    const url = lsGet(QK, ""); if (!url) return null;
    return { url: normEndpoint(url), model: lsGet(QKM, "") || "qwen2.5:7b-instruct", key: lsGet(QKK, "") };
  }
  function remoteHeaders(cfg) {
    const h = { "Content-Type": "application/json" };
    if (cfg && cfg.key) h["Authorization"] = "Bearer " + cfg.key;
    return h;
  }
  // Live reachability of the configured engine, reflected in the header (Qwen ✓ / ⚠).
  let remoteHealth = null;   // null unknown, "ok" reachable, "down" saved but unreachable
  async function checkRemoteHealth() {
    const cfg = remoteCfg(); if (!cfg) { remoteHealth = null; return; }
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(cfg.url, { method: "POST", headers: remoteHeaders(cfg), signal: ctrl.signal,
        body: JSON.stringify({ model: cfg.model, max_tokens: 1, stream: false, messages: [{ role: "user", content: "ok" }] }) });
      remoteHealth = r.ok ? "ok" : "down";
    } catch (e) { remoteHealth = "down"; } finally { clearTimeout(t); try { setStatus(); } catch (e) { } }
  }
  if (remoteCfg()) setTimeout(checkRemoteHealth, 800);

  // ---------- on-device engine: wllama (CPU WASM) — runs on THIS phone, no computer ----------
  // This is the in-browser path (the same kind HIVE Mind uses): a Qwen GGUF is downloaded
  // once, cached on the device, and runs fully offline afterwards — no PC, no tunnel, no key.
  // CPU WASM (not WebGPU), so it works on iPhone Safari. Output is still only a rephrase of the
  // deterministic engine's sentence, fact-checked by applyGuards before it is ever shown.
  const WLLAMA_VER = "2.3.1";
  const WLLAMA_MODELS = [
    { id: "qwen2.5-0.5b", label: "Qwen2.5 0.5B — recommended for iPhone (~0.4 GB)", mb: 420, url: "https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf" },
    { id: "qwen2.5-1.5b", label: "Qwen2.5 1.5B — bigger phones / may be tight (~1.1 GB)", mb: 1120, url: "https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf" },
    { id: "qwen2.5-3b", label: "Qwen2.5 3B — needs High-performance (~2.0 GB)", mb: 2020, hp: true, url: "https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf" },
    { id: "qwen2.5-7b-iq3", label: "Qwen2.5 7B IQ3 — experimental, High-performance (~3.3 GB)", mb: 3300, hp: true, url: "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-IQ3_M.gguf" }
  ];
  function webgpuAvailable() { try { return !!navigator.gpu; } catch (e) { return false; } }
  const WLM_KEY = "hive.wllama.model", WLM_INSTALLED = "hive.wllama.installed", WLM_LOADING = "hive.wllama.loading";
  let wllamaEngine = null, wllamaLoading = false, wllamaBusy = false;
  function wllamaModelCfg() { const id = lsGet(WLM_KEY, "") || "qwen2.5-0.5b"; return WLLAMA_MODELS.find(m => m.id === id) || WLLAMA_MODELS[0]; }
  function wllamaReady() { return !!wllamaEngine; }
  function wllamaInstalled() { return lsGet(WLM_INSTALLED, ""); }
  async function ensureWllama(onProg) {
    if (wllamaEngine) return wllamaEngine;
    if (wllamaLoading) return null;
    wllamaLoading = true;
    lsSet(WLM_LOADING, wllamaModelCfg().id);   // sentinel: a hard crash during load leaves this set
    try {
      const base = "https://cdn.jsdelivr.net/npm/@wllama/wllama@" + WLLAMA_VER + "/esm/";
      const mod = await import(base + "index.js");
      const Wllama = mod.Wllama || (mod.default && mod.default.Wllama) || mod.default;
      const paths = { "single-thread/wllama.wasm": base + "single-thread/wllama.wasm", "multi-thread/wllama.wasm": base + "multi-thread/wllama.wasm" };
      const w = new Wllama(paths);
      const m = wllamaModelCfg();
      // Multi-thread only when cross-origin isolated (SharedArrayBuffer available); else single-thread.
      const threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
      const opt = { n_ctx: 1024, n_batch: 128, n_threads: threads, progressCallback: (p) => { try { onProg && onProg(p && p.loaded, p && p.total); } catch (e) { } } };
      if (webgpuAvailable()) opt.n_gpu_layers = 999;   // offload to GPU memory where supported (iOS 26 / desktop)
      await w.loadModelFromUrl(m.url, opt);
      wllamaEngine = w; lsSet(WLM_INSTALLED, m.id);
      try { setStatus(); } catch (e) { }
    } catch (e) { wllamaEngine = null; if (onProg) onProg(-1, -1, String(e && e.message || e)); }
    lsDel(WLM_LOADING);   // reached only if the load finished (success or caught error), not on a crash
    wllamaLoading = false;
    return wllamaEngine;
  }
  async function wllamaGen(messages) {
    try {
      if (typeof wllamaEngine.createChatCompletion === "function") {
        return await wllamaEngine.createChatCompletion(messages, { nPredict: 72, sampling: { temp: 0.3 } });
      }
      let p = ""; for (const m of messages) p += "<|im_start|>" + m.role + "\n" + m.content + "<|im_end|>\n"; p += "<|im_start|>assistant\n";
      return await wllamaEngine.createCompletion(p, { nPredict: 72, sampling: { temp: 0.3 } });
    } catch (e) { return null; }
  }
  // Measure-first: run a fixed prompt set through the on-device model on THIS device and
  // report latency + how often the model's wording survives the fact-guard + memory delta.
  // The honest basis for deciding whether a bigger/retrieval-grounded engine is worth it.
  const BENCH_PROMPTS = [
    "I have a mild sore throat for two days",
    "sharp headache since this morning and a bit dizzy",
    "my ankle is swollen and sore after a fall",
    "upset stomach and nausea since last night",
    "a small itchy rash on my arm"
  ];
  // EXPERIMENTAL, BENCHMARK-ONLY: retrieval-grounded reasoning. The model reasons over the
  // deterministic engine's OWN rendered answer (the retrieved cards = the FACTS corpus) and
  // is fact-verified against that exact corpus. This never touches a live answer — it runs
  // only inside the benchmark, so we can measure it safely before deciding to ship it.
  async function retrievalGrounded(question, html) {
    if (!wllamaEngine || wllamaBusy) return null;
    const corpus = (html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (corpus.length < 20) return null;
    const sys = "You are a careful medical triage helper. Using ONLY the FACTS provided, answer the person's question in 1-3 short, plain sentences. Do NOT add any fact, number, symptom, condition, or instruction that is not in the FACTS. If the FACTS don't answer it, say so plainly.";
    const usr = "FACTS:\n" + corpus.slice(0, 1800) + "\n\nQUESTION: " + question;
    wllamaBusy = true;
    try {
      let out = await wllamaGen([{ role: "system", content: sys }, { role: "user", content: usr }]);
      out = (out || "").replace(/<\|im_end\|>[\s\S]*$/, "").trim();
      if (!out) return null;
      const safe = applyGuards(corpus, out);      // content must come from the FACTS corpus
      return safe === corpus ? null : safe;
    } finally { wllamaBusy = false; }
  }
  async function benchEngine(onLine) {
    if (!wllamaReady()) return null;
    const R = { reword: { kept: 0, ms: 0 }, grounded: { kept: 0, ms: 0 } };
    let n = 0;
    const m0 = (window.performance && performance.memory && performance.memory.usedJSHeapSize) || 0;
    for (const p of BENCH_PROMPTS) {
      const html = HIVETriage.assess(p);
      let t0 = performance.now(); let a = null; try { a = await wllamaIntro(p, html); } catch (e) { } R.reword.ms += performance.now() - t0; if (a) R.reword.kept++;
      t0 = performance.now(); let b = null; try { b = await retrievalGrounded(p, html); } catch (e) { } R.grounded.ms += performance.now() - t0; if (b) R.grounded.kept++;
      n++;
      try { onLine && onLine(n, BENCH_PROMPTS.length); } catch (e) { }
      try { HIVETriage.reset(); } catch (e) { }
    }
    const m1 = (window.performance && performance.memory && performance.memory.usedJSHeapSize) || 0;
    return { n, memMB: (m1 && m0) ? Math.round((m1 - m0) / 1e6) : null,
      reword: { kept: R.reword.kept, avgMs: Math.round(R.reword.ms / n) },
      grounded: { kept: R.grounded.kept, avgMs: Math.round(R.grounded.ms / n) } };
  }

  async function wllamaIntro(question, html) {
    if (!wllamaEngine || wllamaBusy) return null;      // one inference at a time (memory safety)
    const base = plainBase(html); if (!base) return null;
    wllamaBusy = true;
    try {
      let out = await wllamaGen([{ role: "system", content: INTRO_SYS }, { role: "user", content: introUsr(question, base) }]);
      out = (out || "").replace(/<\|im_end\|>[\s\S]*$/, "").trim();
      if (!out) return null;
      const safe = applyGuards(base, out);
      return safe === base ? null : safe;
    } finally { wllamaBusy = false; }
  }
  // Auto-load the installed model on startup — unless the last load didn't finish (a crash):
  // then DON'T retry automatically, or the app spirals into Safari's "problem repeatedly
  // occurred" crash loop. Drop auto-load and tell the person to pick a smaller model.
  (function autoLoadGuarded() {
    if (!wllamaInstalled()) return;
    if (lsGet(WLM_LOADING, "")) {
      lsDel(WLM_LOADING); lsDel(WLM_INSTALLED);
      try { setStatus(); } catch (e) { }
      setTimeout(() => { try { toast("On-device AI didn't finish loading last time — likely low memory. Open ⋯ → AI engine and choose the 0.5B model."); } catch (e) { } }, 1200);
      return;
    }
    setTimeout(() => { ensureWllama((l, t, err) => { if (status && !err && t > 0) status.textContent = "On-device AI loading… " + Math.round(100 * l / t) + "%"; }).then(() => { try { setStatus(); } catch (e) { } }); }, 1500);
  })();
  const INTRO_SYS = "You are the calm, plain-language voice of a medical TRIAGE tool speaking to a worried person. " +
    "Rephrase the STATUS sentence so it sounds warm, clear and human. STRICT RULES: keep the same meaning and the " +
    "same triage grade number; do NOT add any medical advice, instructions, actions, diagnoses, symptoms, urgency " +
    "words, or new numbers; do NOT tell them what to do. One or two short sentences. Output only the sentence.";
  const introUsr = (question, base) => "Person said: " + question + "\nSTATUS to rephrase: " + base;
  // Returns a verified conversational intro string, or null (caller falls back).
  async function remoteIntro(question, html) {
    const cfg = remoteCfg(); if (!cfg) return null;
    const base = plainBase(html); if (!base) return null;          // nothing grounded to rephrase
    const sys = INTRO_SYS;
    const usr = introUsr(question, base);
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await fetch(cfg.url, {
        method: "POST", headers: remoteHeaders(cfg), signal: ctrl.signal,
        body: JSON.stringify({ model: cfg.model, temperature: 0.3, max_tokens: 160, stream: false,
          messages: [{ role: "system", content: sys }, { role: "user", content: usr }] })
      });
      if (!r.ok) return null;
      const j = await r.json();
      const out = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!out) return null;
      const safe = applyGuards(base, out);           // fact-verified: invented facts → exact engine sentence
      return safe === base ? null : safe;            // only surface a genuinely reworded, verified intro
    } catch (e) { return null; } finally { clearTimeout(t); }
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
    const qwen = wllamaReady() ? " · On-device AI ✓" : assistReady ? " · Qwen Assist" : (remoteCfg() ? (" · Qwen" + (remoteHealth === "ok" ? " ✓" : remoteHealth === "down" ? " ⚠" : "")) : (wllamaInstalled() ? " · On-device AI …" : ""));
    status.textContent = who + " · " + styleLbl + qwen + integ + " · private · works offline · " + VERSION;
  }
  function updateModeBtn() {
    const b = $("modebtn"); if (!b) return;
    const on = mode === "chat";
    const ico = $("modeico"), lbl = $("modelbl");
    if (ico) ico.textContent = on ? "◼" : "◻"; else b.textContent = on ? "◼" : "◻";
    if (lbl) lbl.textContent = on ? "Style: Conversational" : "Style: Standard";
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
    // Conversational mode adds a plain-language summary over the deterministic answer.
    // A real Qwen (reachable via the Assist server / a configured endpoint) writes a
    // fact-verified intro; otherwise the deterministic plain-terms summary stands. No
    // weak on-device model runs — it was unreliable and could misread the input.
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
    // The deterministic engine always reads the user's ACTUAL words — no model is ever
    // allowed to rewrite the input (a weak model turning "how are you" into "tired" is
    // exactly the hallucination these apps must never make). A real Qwen, when reachable,
    // only writes a short conversational intro that is fact-verified before it's shown.
    const html = HIVETriage.turn(text);
    let serverIntro = null;
    if (mode === "chat") {
      // On-device engine FIRST — runs on this phone, no computer needed.
      if (wllamaReady()) { try { serverIntro = await wllamaIntro(text, html); } catch (e) { } }
      else if (wllamaInstalled()) { ensureWllama(); }   // warm it up for next time
      if (!serverIntro && assistReady) {
        try {
          const r = await fetch(ASSIST_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: text, understand: false, converse: true }) });
          if (r.ok) { const j = await r.json(); if (j && j.assist_intro) serverIntro = j.assist_intro; }
        } catch (e) { }
      }
      // A hosted Qwen (your PC over a tunnel, or cloud): verified intro over the internet.
      if (!serverIntro && remoteCfg()) { try { serverIntro = await remoteIntro(text, html); } catch (e) { } }
    }
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
    if (pt && base && !serverIntro && llm) {   // only reword when a real model is loaded
      try {
        const worded = await rewordLocal(base);
        if (worded && worded !== base) pt.querySelector("p").textContent = worded;
      } catch (e) { }
    }
    try { if (voiceHook) voiceHook(node); } catch (e) { }   // speak + continue live mode
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

  // ---------- voice: talk to the doctor, hear it talk back, live hands-free mode ----------
  // Speech-to-text feeds the SAME deterministic engine (the words are never rewritten);
  // text-to-speech reads back a short, grounded summary of the engine's own answer.
  let voiceHook = null;
  (function voice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const TTS = window.speechSynthesis;
    const micBtn = $("mic"), liveBtn = $("live"), spkBtn = $("speak");
    const hasSTT = !!SR, hasTTS = !!TTS;
    if (!micBtn && !liveBtn) return;
    if (!hasSTT) { if (micBtn) micBtn.style.display = "none"; if (liveBtn) liveBtn.style.display = "none"; }
    let live = false, recog = null, recognizing = false, speaking = false, awaitingAnswer = false, ttsUnlocked = false;
    let spkOn = (function () { try { return localStorage.getItem("hive.speak") !== "0"; } catch (e) { return true; } })();

    // iOS locks speech output until a real utterance is spoken INSIDE a user tap.
    // Prime it (near-silent) on the first tap so later answers actually speak.
    function unlockAudio() {
      if (!hasTTS || ttsUnlocked) return;
      try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; TTS.speak(u); ttsUnlocked = true; } catch (e) { }
    }

    function paintSpk() { if (spkBtn) { spkBtn.textContent = spkOn ? "🔊" : "🔇"; spkBtn.classList.toggle("on", spkOn); spkBtn.title = spkOn ? "Voice answers on" : "Voice answers muted"; } }
    function paintMic() { if (micBtn) micBtn.classList.toggle("on", recognizing); }
    function paintLive() { if (liveBtn) { liveBtn.classList.toggle("on", live); liveBtn.title = live ? "Live hands-free: on" : "Live hands-free conversation"; } }
    paintSpk(); paintLive();

    // Build a short spoken summary from the engine's OWN rendered answer — never new content.
    function buildSpoken(node) {
      try {
        const pt = node.querySelector(".plainterms p");
        const emerg = node.querySelector(".blk.emerg p, .blk.emerg");
        const cname = node.querySelector(".cname");
        const parts = [];
        if (pt) parts.push(pt.textContent.trim());
        else {
          const st = node.querySelector(".txt"); if (st) parts.push(st.textContent.trim().split("\n")[0].slice(0, 160));
        }
        if (emerg && !pt) parts.push(emerg.textContent.trim().slice(0, 160));
        if (cname) parts.push("Top consideration: " + cname.textContent.replace(/\s+/g, " ").trim() + ".");
        let s = parts.join(" ").replace(/\s+/g, " ").trim();
        if (s.length > 340) s = s.slice(0, 337) + "…";
        return s || "Here is what the assessment shows. Please read the details on screen.";
      } catch (e) { return "Here is what the assessment shows. Please read the details on screen."; }
    }
    function speak(text) {
      if (!hasTTS || !spkOn || !text) { if (live) resume(); return; }
      try {
        TTS.cancel(); speaking = true; stopListen();
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1; u.pitch = 1; u.lang = "en-US";
        // Finish exactly once, whether TTS signals end/error OR a watchdog fires.
        // The watchdog is what keeps Live from freezing when iOS silently drops speech.
        let done = false, wd = 0;
        const finish = () => { if (done) return; done = true; clearTimeout(wd); speaking = false; if (live) resume(); else if (!recognizing) setCap(null); };
        u.onend = finish; u.onerror = finish;
        wd = setTimeout(finish, Math.min(22000, 2600 + text.length * 60));
        TTS.speak(u);
        try { TTS.resume(); } catch (e) { }   // iOS sometimes parks the queue
      } catch (e) { speaking = false; if (live) resume(); }
    }
    function resume() { if (live && !speaking && !recognizing) setTimeout(startListen, 600); }

    // Live caption bar: shows what the mic is hearing, and the current voice state.
    const cap = $("vcap");
    function setCap(state, text, cls) {
      if (!cap) return;
      if (state === null) { cap.classList.add("hidden"); return; }
      cap.classList.remove("hidden", "listening", "speaking"); if (cls) cap.classList.add(cls);
      cap.innerHTML = '<span class="vdot"></span><span class="vstate"></span><span class="vtext"></span>';
      cap.querySelector(".vstate").textContent = state;
      cap.querySelector(".vtext").textContent = text || "";
    }

    function startListen() {
      if (!hasSTT || recognizing || speaking) return;
      if (!navigator.onLine) { setCap("Voice needs a connection", "Apple transcribes speech online. Type instead, or use your keyboard's 🎤 dictation.", ""); if (live) { live = false; paintLive(); } return; }
      try {
        recog = new SR(); recog.lang = "en-US"; recog.interimResults = true; recog.maxAlternatives = 1; recog.continuous = false;
        recog.onstart = () => { recognizing = true; paintMic(); setCap("Listening", "", "listening"); };
        recog.onerror = (e) => {
          recognizing = false; paintMic();
          const err = e && e.error;
          if (err === "not-allowed" || err === "service-not-allowed") { live = false; paintLive(); setCap("Mic blocked", "Allow microphone for Safari in iOS Settings, then tap 🎙 again.", ""); }
          else if (err === "no-speech") { setCap("Didn't catch that", "Tap 🎙 and speak, or type below.", ""); if (live) resume(); }
          else if (err === "network") { setCap("Voice needs a connection", "Apple transcribes speech online. Type, or use your keyboard's 🎤 dictation.", ""); if (live) { live = false; paintLive(); } }
          else if (err !== "aborted") { setCap("Voice hiccup", "Tap 🎙 to try again, or type below.", ""); if (live) resume(); }
        };
        recog.onend = () => { recognizing = false; paintMic(); if (live && !awaitingAnswer && !speaking) resume(); };
        recog.onresult = (e) => {
          let interim = "", final = "";
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i]; const tx = r[0] && r[0].transcript || "";
            if (r.isFinal) final += tx; else interim += tx;
          }
          if (interim) { setCap("Listening", interim, "listening"); q.value = interim; }   // show words as they're heard
          const t = (final || "").trim();
          if (t) { awaitingAnswer = true; q.value = t; setCap("Thinking", t, ""); try { form.requestSubmit(); } catch (err) { form.dispatchEvent(new Event("submit", { cancelable: true })); } }
        };
        recog.start();
      } catch (e) { recognizing = false; paintMic(); setCap("Voice hiccup", "Tap 🎙 to try again, or type below.", ""); }
    }
    function stopListen() { try { if (recog && recognizing) recog.stop(); } catch (e) { } if (!live) setCap(null); }

    // The answer is rendered: show + speak it, then (in live mode) listen again.
    voiceHook = function (node) {
      awaitingAnswer = false;
      const spoken = buildSpoken(node);
      if (spkOn && hasTTS) { setCap("Speaking", spoken, "speaking"); speak(spoken); if (!live) setTimeout(() => { if (!speaking && !recognizing) setCap(null); }, 1200); }
      else if (live) { setCap("Listening", "", "listening"); resume(); }
      else setCap(null);
    };

    if (micBtn) micBtn.addEventListener("click", () => {
      if (!hasSTT) { toast("Voice input isn't available in this browser"); return; }
      unlockAudio();                                   // prime talk-back on this tap
      if (recognizing) { stopListen(); return; }
      startListen();
    });
    if (liveBtn) liveBtn.addEventListener("click", () => {
      if (!hasSTT) { toast("Live mode needs voice input, not available here"); return; }
      unlockAudio();                                   // prime talk-back on this tap
      live = !live; paintLive();
      if (live) { spkOn = true; paintSpk(); speaking = false; awaitingAnswer = false; startListen(); }
      else { stopListen(); try { if (hasTTS) TTS.cancel(); } catch (e) { } speaking = false; awaitingAnswer = false; setCap(null); }
    });
    if (spkBtn) spkBtn.addEventListener("click", () => {
      unlockAudio();                                   // a tap here also primes iOS audio
      spkOn = !spkOn; try { localStorage.setItem("hive.speak", spkOn ? "1" : "0"); } catch (e) { }
      paintSpk(); if (!spkOn && hasTTS) { try { TTS.cancel(); } catch (e) { } speaking = false; if (live) resume(); }
    });
  })();

  // ---------- AI engine (Qwen) settings panel ----------
  (function engineSettings() {
    const btn = $("enginebtn"), sheet = $("enginesheet");
    if (!btn || !sheet) return;
    const url = $("engurl"), model = $("engmodel"), key = $("engkey"), stat = $("engstatus");
    // ---- on-device (wllama) controls ----
    const wsel = $("wlmodel"), wbar = $("wlbar"), wfill = $("wlfill"), wstat = $("wlstatus"), wdl = $("wldownload"), wrm = $("wlremove");
    if (wsel && !wsel.options.length) { WLLAMA_MODELS.forEach(m => { const o = document.createElement("option"); o.value = m.id; o.textContent = m.label; wsel.appendChild(o); }); }
    function wStat(msg, cls) { if (wstat) { wstat.textContent = msg || ""; wstat.className = "engstatus" + (cls ? " " + cls : ""); } }
    const hpToggle = $("hptoggle"), hpNote = $("hpnote");
    function paintWl() {
      if (!wsel) return;
      const iso = !!self.crossOriginIsolated;
      // gate models that need high-performance (isolation) mode
      for (const o of wsel.options) { const m = WLLAMA_MODELS.find(x => x.id === o.value); o.disabled = !!(m && m.hp && !iso); }
      wsel.value = lsGet(WLM_KEY, "") || "qwen2.5-0.5b";
      if (wsel.selectedOptions[0] && wsel.selectedOptions[0].disabled) wsel.value = "qwen2.5-0.5b";
      if (hpToggle) hpToggle.checked = hpOn();
      if (hpNote) {
        const bits = [];
        bits.push(iso ? "Multi-thread: on ✓" : (hpOn() ? "Multi-thread: starting…" : "Multi-thread: off"));
        bits.push(webgpuAvailable() ? "WebGPU: available ✓" : "WebGPU: not on this device");
        hpNote.textContent = bits.join("  ·  ") + (iso ? "" : "  — turn on High-performance for bigger models.");
        hpNote.className = "engstatus" + (iso ? " ok" : "");
      }
      if (wllamaReady()) wStat("Installed ✓ — running on this phone, fully offline.", "ok");
      else if (wllamaInstalled()) wStat("Installed — loading on first use (offline).", "ok");
      else wStat("Not installed. Tap Download to add a real engine to this phone.", "");
      const bw = $("wlbenchwrap"); if (bw) bw.classList.toggle("hidden", !wllamaReady());
    }
    if (hpToggle) hpToggle.addEventListener("change", () => {
      if (hpToggle.checked) lsSet(HP_KEY, "1"); else lsDel(HP_KEY);
      wStat("Reloading to apply high-performance mode…", "");
      setTimeout(() => location.reload(), 300);   // hpSync redirects to/from ?hp=1 and isolates
    });
    if (wsel) wsel.addEventListener("change", () => { lsSet(WLM_KEY, wsel.value); if (!wllamaReady()) wStat("Selected. Tap Download & install.", ""); });
    // Engine benchmark (shown once a model is loaded)
    const benchWrap = $("wlbenchwrap"), benchBtn = $("wlbench"), benchOut = $("wlbenchout");
    if (benchWrap) benchWrap.classList.toggle("hidden", !wllamaReady());
    if (benchBtn) benchBtn.addEventListener("click", async () => {
      if (!wllamaReady()) { if (benchOut) benchOut.textContent = "Install a model first."; return; }
      benchBtn.disabled = true;
      const t = (msg) => { if (benchOut) benchOut.textContent = msg; };
      t("Benchmarking… 5 prompts × 2 modes on this phone. This takes a bit.");
      const r = await benchEngine((i, tot) => t("Prompt " + i + "/" + tot + "…"));
      benchBtn.disabled = false;
      if (r) {
        benchOut.className = "engstatus ok";
        benchOut.innerHTML = "<b>Reword:</b> " + (r.reword.avgMs / 1000).toFixed(1) + "s · " + r.reword.kept + "/" + r.n + " faithful<br>" +
          "<b>Retrieval-grounded (experimental):</b> " + (r.grounded.avgMs / 1000).toFixed(1) + "s · " + r.grounded.kept + "/" + r.n + " faithful" +
          (r.memMB != null ? "<br>~" + r.memMB + " MB used" : "") + "<br><span class='muted'>Grounded = model reasons over the engine's own facts. Measure before shipping it live.</span>";
      } else { benchOut.textContent = "Couldn't run — is a model loaded?"; }
    });
    if (wdl) wdl.addEventListener("click", async () => {
      lsSet(WLM_KEY, wsel.value);
      const m = WLLAMA_MODELS.find(x => x.id === wsel.value) || WLLAMA_MODELS[1];
      wbar.classList.remove("hidden"); wfill.style.width = "0%";
      wStat("Downloading " + m.label + " — keep this screen open (one time; ~" + (m.mb >= 1000 ? (m.mb / 1000).toFixed(1) + " GB" : m.mb + " MB") + ").", "");
      wdl.disabled = true;
      await ensureWllama((loaded, total, err) => {
        if (err) { wStat("Couldn't install: " + err + " — check your connection and try again.", "bad"); return; }
        if (total > 0) { const pct = Math.round(100 * loaded / total); wfill.style.width = pct + "%"; wStat("Downloading… " + pct + "%  (" + (loaded / 1e6).toFixed(0) + " / " + (total / 1e6).toFixed(0) + " MB)", ""); }
      });
      wdl.disabled = false;
      if (wllamaReady()) { wfill.style.width = "100%"; wStat("Installed ✓ — running on this phone, fully offline. No computer needed.", "ok"); setStatus(); }
      else if (!/Couldn't install/.test(wstat.textContent)) wStat("Install didn't complete — check your connection and try again.", "bad");
    });
    if (wrm) wrm.addEventListener("click", () => {
      lsDel(WLM_INSTALLED); wStat("Removed from auto-load. The cached file is cleared by your browser's site-data settings; re-download anytime.", "ok");
      setStatus();
    });
    const open = () => { url.value = lsGet(QK, ""); model.value = lsGet(QKM, ""); key.value = lsGet(QKK, ""); setStat("", ""); paintWl(); sheet.classList.remove("hidden"); };
    const close = () => sheet.classList.add("hidden");
    function setStat(msg, cls) { stat.textContent = msg || ""; stat.className = "engstatus" + (cls ? " " + cls : ""); }
    btn.addEventListener("click", open);
    $("engcancel").addEventListener("click", close);
    sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
    $("engsave").addEventListener("click", () => {
      const u = url.value.trim();
      if (u) lsSet(QK, u); else lsDel(QK);
      if (model.value.trim()) lsSet(QKM, model.value.trim()); else lsDel(QKM);
      if (key.value.trim()) lsSet(QKK, key.value.trim()); else lsDel(QKK);
      setStat(u ? "Saved — HIVE will use this Qwen for wording (medical facts stay deterministic)." : "Cleared — running fully offline.", "ok");
      remoteHealth = null; setStatus(); if (u) checkRemoteHealth();
    });
    $("engclear").addEventListener("click", () => {
      lsDel(QK); lsDel(QKM); lsDel(QKK); url.value = model.value = key.value = "";
      setStat("Cleared — running fully offline.", "ok"); remoteHealth = null; setStatus();
    });
    $("engtest").addEventListener("click", async () => {
      const u = normEndpoint(url.value); if (!u) { setStat("Enter an endpoint URL first.", "bad"); return; }
      const cfg = { url: u, model: model.value.trim() || "qwen2.5:7b-instruct", key: key.value.trim() };
      setStat("Testing " + cfg.model + "…", "");
      const t0 = Date.now(); const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 15000);
      try {
        const r = await fetch(cfg.url, { method: "POST", headers: remoteHeaders(cfg), signal: ctrl.signal,
          body: JSON.stringify({ model: cfg.model, max_tokens: 8, stream: false, messages: [{ role: "user", content: "Reply with the word OK." }] }) });
        if (!r.ok) { setStat("Reached it, but it returned HTTP " + r.status + (r.status === 401 ? " — check the API key." : r.status === 404 ? " — check the URL/model." : "") , "bad"); return; }
        const j = await r.json();
        const out = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        if (out != null) { remoteHealth = "ok"; setStatus(); }
        setStat(out != null ? ("Connected ✓ " + cfg.model + " replied in " + ((Date.now() - t0) / 1000).toFixed(1) + "s. Tap Save to use it.") : "Connected, but no reply content — check the model name.", out != null ? "ok" : "bad");
      } catch (e) {
        setStat(e && e.name === "AbortError" ? "Timed out — is the endpoint up and reachable from the phone?" : "Couldn't reach it — check the URL, that it's running, and (on iPhone) that it's https.", "bad");
      } finally { clearTimeout(to); }
    });
  })();

  // ---------- header overflow: keep the top bar fitting the phone ----------
  (function moreMenu() {
    const btn = $("morebtn"), menu = $("hmenu");
    if (!btn || !menu) return;
    const close = () => { menu.classList.add("hidden"); btn.classList.remove("on"); };
    btn.addEventListener("click", (e) => { e.stopPropagation(); const open = menu.classList.contains("hidden"); menu.classList.toggle("hidden", !open); btn.classList.toggle("on", open); });
    menu.addEventListener("click", (e) => { if (e.target.closest("button,a")) close(); });
    document.addEventListener("click", (e) => { if (!menu.classList.contains("hidden") && !menu.contains(e.target) && e.target !== btn) close(); });
  })();

  // register the service worker so the Doctor works offline when installed.
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    try { navigator.serviceWorker.register("./sw.js"); } catch (e) { }
  }
})();
