/* HIVE Doctor — Deterministic clinical reasoning engine
   No randomness. No LLM in the reasoning path. Same inputs -> identical output.
   Reference/triage only: possible causes, urgency, grounded next step. Not a
   diagnosis or prescription. Emergencies: call 911/112/999.
   Not independently verified by a licensed clinician.
*/
"use strict";
(function (global) {
  const F = (p) => fetch(p, { cache: "no-store" }).then(r => r.ok ? r.json() : null).catch(() => null);

  const URG_RANK = { emergency: 0, urgent: 1, prompt: 2, routine: 3, selfcare: 4 };
  const URG_LABEL = {
    emergency: "EMERGENCY — call your local emergency number now",
    urgent: "Urgent — be seen today (urgent care or ER)",
    prompt: "Soon — see a clinician within 24–72 hours",
    routine: "Routine — arrange a normal appointment",
    selfcare: "Self-care — usually manageable at home; seek care if it worsens"
  };
  const NEG = ["no ", "not ", "without ", "don't have", "dont have", "denies", "deny ", "never had", "no sign of", "free of"];

  const E = {
    map: null, book: null, cond: null, drug: null, guide: null, ref: {}, loaded: false,
    // conversation state (deterministic accumulation)
    present: new Set(), absent: new Set(), asked: new Set(), turns: 0, profile: {}
  };

  // Sex/pregnancy applicability for context filtering (deterministic).
  const MALE_ONLY = new Set(["prostatitis", "bph", "ca_warn_testicular"]);
  const FEMALE_ONLY = new Set(["menopause", "pcos", "endometriosis", "mastitis", "menorrhagia", "dysmenorrhea", "threatened_miscarriage", "hyperemesis", "labor", "ectopic", "pid", "ca_warn_gynae", "ca_warn_ovarian"]);
  const PREG_CONDS = new Set(["labor", "ectopic", "threatened_miscarriage", "hyperemesis"]);
  const NUTRI_BY_AGE = [[0, "infant_0_6", 0.5], [0.5, "infant_6_12", 1], [1, "toddler_1_3", 4], [4, "child_4_12", 13], [13, "teen_13_18", 18], [18, "adult_19_64", 65], [65, "older_65", 200]];

  async function load() {
    const [map, book, cond, drug, guide, onco, nutri, exam, anat, phys, histo, plans, meds, lex, support, specialists, figures, photos] = await Promise.all([
      F("hive_symptom_map.json"), F("doctor_book.json"),
      F("hive_conditions_ref.json"), F("hive_drug_reference.json"), F("hive_extra_guides.json"),
      F("hive_oncology_ref.json"), F("hive_nutrition_ref.json"), F("hive_exam_ref.json"),
      F("hive_anatomy_ref.json"), F("hive_physiology_ref.json"), F("hive_histology_ref.json"),
      F("hive_care_plans.json"), F("hive_med_safety.json"), F("hive_lexicon.json"), F("hive_support.json"), F("hive_specialists.json"),
      F("figures.json"), F("photos.json")
    ]);
    E.map = map; E.book = book; E.cond = cond; E.drug = drug; E.guide = guide; E.onco = onco; E.nutri = nutri; E.exam = exam;
    // The Book is the single source: when no separate reference file ships, read the layers from it.
    if (!E.cond && book && Array.isArray(book.conditions_ref)) E.cond = { cards: book.conditions_ref };
    if (!E.drug && book && Array.isArray(book.drug_reference)) E.drug = { cards: book.drug_reference };
    if (!E.guide && book && Array.isArray(book.field_guides)) E.guide = { cards: book.field_guides };
    buildRefIndex();
    E.anat = anat; E.phys = phys; E.histo = histo; E.plans = plans; E.meds = meds; E.lex = lex; E.support = support; E.specialists = specialists;
    E.figures = (figures && figures.figures) ? figures.figures : [];
    E.photos = (photos && photos.photos) ? photos.photos : [];
    for (const x of E.photos) x.keys = (x.keys_raw || []).map(k => norm(k).trim()).filter(Boolean);
    // build the lay-term comprehension index (longest aliases first)
    E.lexList = [];
    if (E.lex && E.lex.map) {
      const keys = Object.keys(E.lex.map).sort((a, b) => (b.split(/\s+/).length - a.split(/\s+/).length) || (b.length - a.length));
      for (const k of keys) {
        const w = norm(k).trim().split(/\s+/).filter(Boolean).map(escRe);
        if (!w.length) continue;
        const negStart = /^(no|not|non|never|without|low)\b/.test(norm(k).trim());
        E.lexList.push({ re: new RegExp("(^|\\s)(" + w.join("\\s+") + ")(?=\\s|$)", "g"), to: E.lex.map[k], negStart });
      }
    }
    // Build grounded reference index: ref id -> {label, text, source}
    const idx = {};
    if (book && Array.isArray(book.entries)) for (const e of book.entries) {
      const t = [e.do_now, e.get_help_fast].filter(Boolean).join(" ");
      idx["book:" + e.id] = { label: e.title || e.id, text: t, source: "HIVE Doctor field guide" };
    }
    const cardSrc = (arr, src) => { if (arr && Array.isArray(arr.cards)) for (const c of arr.cards) idx[src + ":" + c.id] = { label: (c.id || "").replace(/^(cond_|drug_)/, "").replace(/_/g, " "), text: c.answer || "", source: c.source || "" }; };
    cardSrc(E.cond, "cond"); cardSrc(E.drug, "drug"); cardSrc(E.guide, "guide");
    // oncology reference (optional layer)
    if (E.onco && Array.isArray(E.onco.cancers)) for (const c of E.onco.cancers) idx["onco:" + c.id] = { label: c.name, text: [c.warning_signs, c.when_to_see].filter(Boolean).join(" "), source: c.source || "Oncology reference" };
    if (E.onco && Array.isArray(E.onco.treatments)) for (const tr of E.onco.treatments) idx["treat:" + tr.id] = { label: tr.name, text: [tr.common_side_effects, tr.managing].filter(Boolean).join(" "), source: tr.source || "Oncology reference" };
    E.ref = idx;
    // precompile phrase regexes (deterministic, order-stable)
    E.rx = {};
    for (const sid of Object.keys(map.symptoms)) {
      E.rx[sid] = (map.symptoms[sid].phrases || []).map(compilePhrase).filter(Boolean);
    }
    // knowledge-web indexes
    E.condById = {};
    for (const c of map.conditions) E.condById[c.id] = c;
    E.linkIndex = {};
    for (const l of (map.links || [])) (E.linkIndex[l.from] = E.linkIndex[l.from] || []).push(l);
    buildMedIndex();
    E.loaded = true;
    return E;
  }

  // Common phone/txt-speak contractions -> full words, so emergencies still
  // recall from messy real typing ("cnt breathe", "bleedin thru", "32 wks preg").
  const TXTSPEAK = {
    cnt: "cant", dnt: "dont", wnt: "wont", goin: "going", gaspin: "gasping",
    bleedin: "bleeding", breathin: "breathing", swellin: "swelling", droopin: "drooping",
    hurtin: "hurting", feelin: "feeling", burnin: "burning", vomitin: "vomiting",
    thru: "through", wks: "weeks", wk: "week", preg: "pregnant", preggo: "pregnant",
    rlly: "really", evr: "ever", rite: "right", abt: "about", bcuz: "because",
    cuz: "because", pls: "please", plz: "please", u: "you", ur: "your", r: "are",
    thr: "there", wer: "were", wheres: "where is", whats: "what is"
  };
  function norm(s) {
    let out = (" " + (s || "").toLowerCase() + " ")
      .replace(/['’‘`]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ");
    out = out.replace(/\b(cnt|dnt|wnt|goin|gaspin|bleedin|breathin|swellin|droopin|hurtin|feelin|burnin|vomitin|thru|wks|wk|preg|preggo|rlly|evr|rite|abt|bcuz|cuz|pls|plz|ur|thr|wer|wheres|whats)\b/g, m => TXTSPEAK[m] || m);
    return out;
  }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  // Compile a phrase to a regex that tolerates up to 2 filler words between
  // the phrase words ("arm weak" also matches "arm is weak", "arm feels weak").
  function compilePhrase(ph) {
    const w = norm(ph).trim().split(/\s+/).filter(Boolean).map(escRe);
    if (!w.length) return null;
    return new RegExp("(?:^|\\s)" + w.join("(?:\\s+\\w+){0,2}\\s+") + "(?:\\s|$)");
  }
  // Robust negation: a negation word within ~20 chars before the hit.
  const NEGRE = /\b(no|not|non|never|without|deny|denies|denied|free of|negative for|doesn t have|don t have|didn t have|dont have|doesnt have|didnt have|havent|hasnt|haven t|hasn t)\b/;

  // Translate everyday words / nicknames / slang into the clinical terms the
  // engine reasons with, before matching. Deterministic, longest-alias-first.
  function aliasCanon(t) {
    if (!E.lexList || !E.lexList.length) return t;
    for (const e of E.lexList) {
      e.re.lastIndex = 0;
      // Normal aliases keep the original words and append the clinical term.
      // Aliases whose key starts with a negation word (e.g. "no energy" = fatigue)
      // drop the original text so the leading "no" can't trip negation detection.
      t = t.replace(e.re, e.negStart ? ("$1" + e.to) : ("$1$2 " + e.to));
    }
    return t;
  }

  // Deterministic phrase match. Returns {present:Set, absent:Set} for THIS text.
  function extract(text) {
    const present = new Set(), absent = new Set();
    const scan = (t) => {
      for (const sid of Object.keys(E.map.symptoms)) {
        if (present.has(sid)) continue; // already confirmed present elsewhere
        const rxs = E.rx[sid] || [];
        for (const re of rxs) {
          re.lastIndex = 0;
          const m = re.exec(t);
          if (!m) continue;
          // If the matched phrase itself begins with a negation word (e.g.
          // "no energy", "no appetite"), that word is part of the symptom name,
          // not a negation — so look only at text strictly BEFORE the match.
          const hit = (m[0] || "").trim();
          const startsNeg = /^(no|not|non|never|without|low)\b/.test(hit);
          // Negation only scopes the current clause: a "no"/"not" before a
          // conjunction or comma (e.g. "no sleep AND racing thoughts",
          // "no fever BUT headache") must not negate what comes after it.
          let pre = t.slice(Math.max(0, m.index - 20), m.index);
          pre = pre.split(/\b(?:and|but|then|also|plus|though|yet|however)\b|[,;]/).pop();
          if (!startsNeg && NEGRE.test(pre)) absent.add(sid); else present.add(sid);
          break; // first matching phrase is enough for this symptom
        }
      }
    };
    // Pass 1: alias-expanded text (slang/nicknames -> clinical terms).
    // Pass 2: plain normalized text — alias expansion appends multi-word
    // clinical terms inline, which can push a specific multi-word phrase past
    // its filler-word window (e.g. "gasping for air" -> severe_breathing); the
    // raw pass recovers those literal matches. Present wins across both passes.
    const tA = aliasCanon(norm(text));
    const tR = norm(text);
    scan(tA);
    if (tR !== tA) scan(tR);
    for (const s of present) absent.delete(s);
    return { present, absent };
  }

  function computeDerived(p) {
    if (p.heightCm && p.weightKg) {
      const m = p.heightCm / 100; p.bmi = Math.round((p.weightKg / (m * m)) * 10) / 10;
      p.bmiCat = p.bmi < 18.5 ? "below the healthy range" : p.bmi < 25 ? "healthy range" : p.bmi < 30 ? "overweight range" : "obese range";
    }
    if (p.ageYears != null) {
      const y = p.ageYears;
      p.ageBand = y < 1 ? "infant" : y < 4 ? "toddler" : y < 13 ? "child" : y < 18 ? "teen" : y < 65 ? "adult" : "older";
    }
    return p;
  }
  function setProfile(obj) {
    for (const k in obj) { if (obj[k] != null) E.profile[k] = obj[k]; }
    computeDerived(E.profile); return E.profile;
  }
  function parseProfile(t) {
    const p = {}; let m;
    if ((m = t.match(/(\d{1,2})\s*month(?:s)?\s*old/))) { p.ageMonths = parseInt(m[1], 10); p.ageYears = Math.round((p.ageMonths / 12) * 100) / 100; }
    else if ((m = t.match(/(\d{1,3})\s*(?:years?|yrs?|yo|y\/o|year[\s-]?old)/))) { p.ageYears = parseInt(m[1], 10); p.ageMonths = p.ageYears * 12; }
    else if ((m = t.match(/(\d{1,2})\s*day[\s-]?old/))) { p.ageDays = parseInt(m[1], 10); p.ageMonths = Math.round((p.ageDays / 30) * 100) / 100; p.ageYears = 0; }
    else if ((m = t.match(/(\d{1,2})\s*weeks?\s*old/))) { p.ageDays = parseInt(m[1], 10) * 7; p.ageMonths = Math.round((p.ageDays / 30) * 100) / 100; p.ageYears = 0; }
    else if (/\b(a few|couple of|couple|several|few)\s*weeks?\s*old\b/.test(t)) { p.ageDays = 21; p.ageMonths = 0.7; p.ageYears = 0; }
    else if (/\b(a few|couple of|couple|several|few)\s*days?\s*old\b/.test(t)) { p.ageDays = 4; p.ageMonths = 0.13; p.ageYears = 0; }
    else if (/\bnewborn\b/.test(t)) { p.ageMonths = 1; p.ageYears = 0; p.ageDays = 7; }
    if (/\b(female|woman|girl)\b/.test(t)) p.sex = "female";
    else if (/\b(male|man|boy)\b/.test(t)) p.sex = "male";
    if ((m = t.match(/(\d{2,3})\s*cm/))) p.heightCm = parseInt(m[1], 10);
    else if ((m = t.match(/(\d)\s*(?:'|ft|foot|feet)\s*(\d{1,2})/))) p.heightCm = Math.round((parseInt(m[1], 10) * 12 + parseInt(m[2], 10)) * 2.54);
    if ((m = t.match(/(\d{2,3})\s*(?:kg|kilo)/))) p.weightKg = parseInt(m[1], 10);
    else if ((m = t.match(/(\d{2,3})\s*(?:lbs?|pounds?)/))) p.weightKg = Math.round(parseInt(m[1], 10) * 0.4536);
    if (/\bnot pregnant\b/.test(t)) p.pregnant = false;
    else if (/\bpregnant\b|\bexpecting\b|weeks pregnant/.test(t)) p.pregnant = true;
    else { const gw = t.match(/\b(?:i ?a?m|i'?m)\s+(\d{1,2})\s*weeks\b/); if (gw && +gw[1] >= 8 && +gw[1] <= 42) p.pregnant = true; } // "i'm 32 weeks" = gestation
    return p;
  }
  function profileBlock() {
    const p = E.profile; if (!p || !Object.keys(p).length) return "";
    const bits = [];
    if (p.ageMonths != null && p.ageMonths < 24) bits.push(p.ageMonths + " month" + (p.ageMonths === 1 ? "" : "s"));
    else if (p.ageYears != null) bits.push(p.ageYears + "y");
    if (p.sex) bits.push(esc(p.sex));
    if (p.heightCm) bits.push(p.heightCm + " cm");
    if (p.weightKg) bits.push(p.weightKg + " kg");
    if (p.bmi) bits.push("BMI " + p.bmi + " (" + esc(p.bmiCat) + ")");
    if (p.pregnant === true) bits.push("pregnant");
    if (p.history && p.history.length) bits.push("history: " + esc(p.history.join(", ")));
    if (p.meds && p.meds.length) bits.push(p.meds.length + " medicine" + (p.meds.length > 1 ? "s" : "") + " on file");
    if (!bits.length) return "";
    return `<div class="blk"><div class="htag">Profile in use</div><div class="webitem">${bits.join(" · ")}<div class="ref"><span class="src">Used to tailor risk and context — not a dose or a diagnosis.</span></div></div></div>`;
  }

  function redflagHits() {
    const out = [];
    for (const rf of E.map.redflags) {
      let ok = true;
      if (rf.all_of) ok = rf.all_of.every(s => E.present.has(s));
      if (ok && rf.any_of) {
        const n = rf.any_of.filter(s => E.present.has(s)).length;
        ok = n >= (rf.min_count || 1);
      }
      if (ok && !rf.all_of && !rf.any_of) ok = false;
      if (ok) out.push(rf);
    }
    // profile-aware: fever in a baby under 3 months is always urgent
    if (E.profile.ageMonths != null && E.profile.ageMonths < 3 && E.present.has("fever")) {
      out.push({ id: "rf_infant_fever", urgency: "emergency", ref: { guide: "fever_in_children" }, msg: "A fever in a baby under 3 months always needs urgent medical assessment — young babies can become seriously unwell very quickly. Seek care now." });
    }
    // profile-aware: jaundice in a newborn needs same-day assessment
    if ((E.profile.ageDays != null && E.profile.ageDays < 28 || (E.profile.ageMonths != null && E.profile.ageMonths < 1)) && E.present.has("jaundice")) {
      out.push({ id: "rf_neonatal_jaundice", urgency: "urgent", ref: null, msg: "Jaundice (yellow skin or eyes) in a newborn needs same-day assessment — especially if it reaches the tummy or legs, started in the first 24 hours, or the baby is sleepy or feeding poorly. Contact your midwife, GP, or maternity/neonatal unit today." });
    }
    // profile-aware: in pregnancy, headache + visual change / swelling / raised BP suggests pre-eclampsia
    if (E.profile.pregnant === true && E.present.has("headache") &&
      (E.present.has("hand_swelling") || E.present.has("high_bp_sym") || E.present.has("preeclampsia_signs") ||
        E.present.has("vision_loss") || E.present.has("vision_gradual_blur"))) {
      out.push({ id: "rf_preeclampsia_profile", urgency: "emergency", ref: null, msg: "In pregnancy, a severe or persistent headache with visual changes, swelling of the face or hands, or raised blood pressure can mean pre-eclampsia — a serious emergency for both you and the baby. Get urgent maternity assessment now (your maternity triage/labour ward, or emergency services)." });
    }
    // text-aware: a medicine swallowed by a child, by accident, or in excess is a poisoning call
    const lt = E.lastText || "";
    const drugNamed = !!(E.medSyn && parseMeds(lt).length);
    if (!out.some(r => /^rf_(overdose|poison_ingest|chemical_ingest)$/.test(r.id)) && INGEST_WHO_RX.test(lt) && (INGEST_RX.test(lt) || (drugNamed && /\b(swallow\w*|ate|eaten|drank|chewed|got into|ingested|took|taken)\b/.test(lt)))) {
      out.push({ id: "rf_poison_ingest", urgency: "emergency", ref: { guide: "when_to_seek_care" }, msg: "A medicine swallowed by a child, by mistake, or in a larger amount than intended needs advice now, even if the person seems well: some medicines cause no symptoms for hours. Call Poison Control (US and Canada 1-800-222-1222; elsewhere your local poison centre) or your emergency number. Call emergency services at once for drowsiness, trouble breathing, a seizure or collapse. Do not make them vomit. Keep the container and note what was taken, how much, and when." });
    }
    if (/\b(dog|cat|pet|puppy|kitten|rabbit)\b/.test(lt) && out.some(r => /^rf_(overdose|poison_ingest|chemical_ingest)$/.test(r.id))) {
      out.push({ id: "rf_pet_poison", urgency: "emergency", ref: null, msg: "For a pet, call a veterinarian or an animal poison helpline now. Human poison centres may not be able to advise on animals, and some human medicines are far more dangerous to pets." });
    }
    if (SELF_HARM_RX.test(lt) && !out.some(r => r.id === "rf_suicide")) {
      out.push({ id: "rf_suicide", urgency: "emergency", ref: { guide: "suicide_crisis" }, msg: "You matter, and you deserve support right now. If you might act on thoughts of harming yourself, call or text your local crisis line (in the US and Canada, 988) or emergency services. You do not have to face this alone." });
    }
    // emergency before urgent; stable by id
    out.sort((a, b) => (URG_RANK[a.urgency] - URG_RANK[b.urgency]) || (a.id < b.id ? -1 : 1));
    return out;
  }

  // Deterministic differential scoring.
  function score() {
    const rows = [];
    for (const c of E.map.conditions) {
      let s = 0, matched = [], strong = false, maxW = 0;
      for (const [sym, w] of c.feats) {
        if (E.present.has(sym)) { s += w; if (w >= 5) strong = true; if (w > 0) { matched.push(sym); if (w > maxW) maxW = w; } }
        else if (E.absent.has(sym) && w > 0) { s -= Math.min(2, w); } // absence of an expected feature argues down, capped
      }
      // Need real signal: a strong single feature (w>=4), or at least two features, or a high total.
      if (matched.length && (s >= 4 || maxW >= 4 || matched.length >= 2)) {
        let band = s >= 8 && strong ? "strong" : (s >= 4 ? "possible" : "weak");
        rows.push({ c, s, band, matched });
      }
    }
    // rank: higher score first, then emergency urgency first, then id alpha (determinism)
    rows.sort((a, b) => (b.s - a.s) || (URG_RANK[a.c.urgency] - URG_RANK[b.c.urgency]) || (a.c.id < b.c.id ? -1 : 1));
    // profile context: drop causes that don't apply to this person
    const P = E.profile; let out = rows;
    if (P.sex === "male") out = out.filter(r => !FEMALE_ONLY.has(r.c.id));
    if (P.sex === "female") out = out.filter(r => !MALE_ONLY.has(r.c.id));
    if (P.pregnant === false) out = out.filter(r => !PREG_CONDS.has(r.c.id));
    // Specificity: reproducible chest-wall tenderness with ZERO cardiac features argues against
    // acute coronary syndrome — don't let isolated chest pain alone drive a cardiac emergency.
    if (E.present.has("chest_wall_tender") && !["pain_radiates_arm_jaw", "sweating", "shortness_breath", "crushing_chest", "exertional", "syncope", "chest_pressure", "sob_sudden"].some(s => E.present.has(s))) {
      out = out.filter(r => r.c.id !== "acs");
    }
    // Specificity: a faint with a clear vasovagal warning (hot/sweaty/light-headed beforehand) and
    // NO chest component or exertional trigger is not acute coronary syndrome.
    const chestComp = ["chest_pain", "chest_pressure", "pain_radiates_arm_jaw", "crushing_chest", "shortness_breath"].some(s => E.present.has(s));
    if (E.present.has("faint_warning") && !chestComp && !E.present.has("exertional")) {
      out = out.filter(r => r.c.id !== "acs");
    }
    return out;
  }

  const SYSLABEL = {
    cardiac: "heart & circulation", vascular: "blood vessels", respiratory: "breathing & lungs",
    gi: "digestive", gu: "urinary & pelvic", neuro: "brain & nerves", msk: "bones, joints & muscles",
    derm: "skin", endo: "hormones & metabolism", env: "environmental", eye: "eyes", ent: "ear/nose/throat",
    mh: "mental health", ob: "pregnancy & birth", onc: "possible-cancer warning", general: "whole-body",
    allergy: "allergy"
  };
  // triage system -> 3D anatomy layer (body3d.html?focus=<layer>). Lets the chat
  // open the relevant body system in the 3D view. Unmapped systems -> no link.
  const SYS_TO_3D = {
    cardiac: "cardiovascular", vascular: "cardiovascular", respiratory: "respiratory",
    gi: "digestive", gu: "urinary", neuro: "nervous", mh: "nervous", msk: "muscle",
    derm: "skin", env: "skin", endo: "organs", ent: "respiratory", allergy: "respiratory",
    ob: "reproductive", onc: "organs", general: "organs"
  };
  const syslabel = (s) => SYSLABEL[s] || s;

  // The kernel map: which body systems are "in focus" — from the symptoms given,
  // expanded along the web to connected systems. This is the index that narrows.
  function focusSystems(rows) {
    const sys = new Set();
    for (const s of E.present) { const sm = E.map.symptoms[s]; if (sm && sm.system) sys.add(sm.system); }
    for (const r of rows) {
      if (r.s < 4) continue;
      for (const l of ((E.linkIndex && E.linkIndex[r.c.id]) || [])) {
        const tc = E.condById[l.to]; if (tc && tc.system) sys.add(tc.system);
      }
    }
    return sys;
  }

  // Cluster ranked rows by body system; focus systems lead, weak off-focus noise is pruned.
  function cluster(rows, focus) {
    const groups = {};
    for (const r of rows) {
      const inF = !focus || focus.has(r.c.system);
      // never prune cancer-warnings or anything urgent/emergency; only weak off-focus routine noise
      const protectedRow = r.c.system === "onc" || URG_RANK[r.c.urgency] <= 1;
      if (!inF && r.s < 6 && !protectedRow) continue; // eliminate weak out-of-focus matches ("zero the focus")
      (groups[r.c.system] = groups[r.c.system] || []).push(r);
    }
    const order = Object.keys(groups).sort((A, B) => {
      const af = (focus && focus.has(A)) ? 0 : 1, bf = (focus && focus.has(B)) ? 0 : 1;
      if (af !== bf) return af - bf; // in-focus systems first
      const a = groups[A][0], b = groups[B][0];
      return (URG_RANK[a.c.urgency] - URG_RANK[b.c.urgency]) || (b.s - a.s) || (A < B ? -1 : 1);
    });
    return order.map(sys => ({ system: sys, rows: groups[sys].slice(0, 4), inFocus: !!(focus && focus.has(sys)) }));
  }

  // Next best question: among top candidates, the unknown feature with the
  // greatest aggregate discriminating weight. Deterministic tie-break by sym id.
  function nextQuestion(rows) {
    // Vague/general complaint: ask an open, warm question before presuming a
    // specific symptom (e.g. don't ask about a cough the person never raised).
    if (E.present.has("malaise") && !E.asked.has("malaise")) {
      const specifics = [...E.present].filter(s => {
        const sy = E.map.symptoms[s];
        return s !== "malaise" && sy && sy.system && sy.system !== "general";
      });
      if (specifics.length === 0 && E.map.symptoms.malaise && E.map.symptoms.malaise.ask) {
        E.asked.add("malaise"); E.lastAskSym = "malaise"; return E.map.symptoms.malaise.ask;
      }
    }
    const agg = {};
    for (const r of rows.slice(0, 6)) for (const [sym, w] of r.c.feats) {
      if (w <= 0) continue;
      if (E.present.has(sym) || E.absent.has(sym) || E.asked.has(sym)) continue;
      agg[sym] = (agg[sym] || 0) + w;
    }
    // spread activation: linked conditions' discriminating features, at reduced weight
    if (E.linkIndex) for (const r of rows.filter(x => x.s >= 4).slice(0, 5)) {
      for (const l of (E.linkIndex[r.c.id] || [])) {
        const tc = E.condById[l.to]; if (!tc) continue;
        for (const [sym, w] of tc.feats) {
          if (w < 4) continue; // only strong discriminators from linked nodes
          if (E.present.has(sym) || E.absent.has(sym) || E.asked.has(sym)) continue;
          agg[sym] = (agg[sym] || 0) + Math.floor(w / 2);
        }
      }
    }
    const best = Object.keys(agg).sort((a, b) => (agg[b] - agg[a]) || (a < b ? -1 : 1))[0];
    if (!best) return null;
    const sym = E.map.symptoms[best];
    if (!sym || !sym.ask) { E.asked.add(best); return nextQuestionSkip(rows, best); }
    E.asked.add(best); E.lastAskSym = best;
    return sym.ask;
  }
  function nextQuestionSkip(rows, skip) {
    // if the chosen symptom has no written question, try the next one
    return nextQuestion(rows);
  }

  function refBlock(ref) {
    if (!ref) return "";
    const key = ref.book ? "book:" + ref.book : ref.cond ? "cond:" + ref.cond : ref.guide ? "guide:" + ref.guide : ref.drug ? "drug:" + ref.drug : ref.onco ? "onco:" + ref.onco : ref.treat ? "treat:" + ref.treat : "";
    const r = E.ref[key];
    if (!r) return "";
    let snip = (r.text || "").replace(/\s+/g, " ").trim();
    if (snip.length > 220) snip = snip.slice(0, 217).replace(/\s+\S*$/, "") + "…";
    const src = r.source ? " · " + esc(r.source) : "";
    return snip ? `<div class="ref"><b>More:</b> ${esc(snip)}<span class="src">${src}</span></div>` : "";
  }

  function esc(s) { return (s || "").replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])); }

  // Oncology / treatment reference lookup (deterministic phrase scan of last input).
  function oncoBlock() {
    if (!E.onco || !E.lastText) return "";
    const t = E.lastText;
    const hit = (arr) => (arr || []).filter(x => (x.phrases || []).some(p => t.indexOf(norm(p).trim()) >= 0));
    const cans = hit(E.onco.cancers), trs = hit(E.onco.treatments);
    if (!cans.length && !trs.length) return "";
    let html = `<div class="blk"><div class="htag">Oncology reference</div>`;
    for (const c of cans) {
      html += `<div class="cand prompt"><div class="cname">${esc(c.name)}</div>`;
      if (c.warning_signs) html += `<div class="act"><b>Warning signs:</b> ${esc(c.warning_signs)}</div>`;
      if (c.screening) html += `<div class="act"><b>Screening:</b> ${esc(c.screening)}</div>`;
      if (c.when_to_see) html += `<div class="watch"><b>When to be seen:</b> ${esc(c.when_to_see)}</div>`;
      html += `<div class="ref"><span class="src">${esc(c.source || "")}</span></div></div>`;
    }
    for (const tr of trs) {
      html += `<div class="cand routine"><div class="cname">${esc(tr.name)}</div>`;
      if (tr.how_it_works) html += `<div class="act">${esc(tr.how_it_works)}</div>`;
      if (tr.common_side_effects) html += `<div class="act"><b>Common side effects:</b> ${esc(tr.common_side_effects)}</div>`;
      if (tr.managing) html += `<div class="act"><b>Managing them:</b> ${esc(tr.managing)}</div>`;
      if (tr.seek_care) html += `<div class="watch"><b>Call your oncology team / seek care for:</b> ${esc(tr.seek_care)}</div>`;
      html += `<div class="ref"><span class="src">${esc(tr.source || "")} · reference only — follow your oncology team</span></div></div>`;
    }
    html += `</div>`;
    return html;
  }

  // Knowledge web: spreading activation from matched anchors to connected concerns.
  const REL = {
    risk: { v: "raises the risk of", cls: "risk", lab: "risk" },
    complication: { v: "can lead to", cls: "comp", lab: "complication" },
    progression: { v: "can progress to", cls: "comp", lab: "progression" },
    associated: { v: "often goes with", cls: "assoc", lab: "linked" },
    mimics: { v: "can be confused with", cls: "mimic", lab: "mimics" }
  };
  const RELPRIO = { complication: 0, progression: 1, risk: 2, mimics: 3, associated: 4 };
  function connected(rows) {
    if (!E.linkIndex) return "";
    const inDiff = new Set(rows.map(r => r.c.id));
    const anchors = rows.filter(r => r.s >= 4).slice(0, 5);
    const seen = new Set(); const items = [];
    for (const a of anchors) {
      for (const l of (E.linkIndex[a.c.id] || [])) {
        const tc = E.condById[l.to]; if (!tc) continue;
        const key = l.to; if (seen.has(key)) continue; seen.add(key);
        items.push({ from: a.c, to: tc, l, anchorScore: a.s, alreadyShown: inDiff.has(l.to) });
      }
    }
    if (!items.length) return "";
    items.sort((x, y) => (y.anchorScore - x.anchorScore) ||
      (RELPRIO[x.l.rel] - RELPRIO[y.l.rel]) || (x.to.id < y.to.id ? -1 : 1));
    let html = `<div class="blk web"><div class="htag">Connected — where this can lead (the web)</div>`;
    for (const it of items.slice(0, 6)) {
      const r = REL[it.l.rel] || REL.associated;
      html += `<div class="webitem"><span class="rel ${r.cls}">${r.lab}</span> <b>${esc(it.from.name)}</b> ${r.v} <b>${esc(it.to.name)}</b> — ${esc(it.l.note)}</div>`;
    }
    html += `</div>`;
    return html;
  }

  // Nutrition guide lookup (deterministic phrase scan of last input).
  const NUTRI_INTENT = /\b(nutrition|diet|eat|eating|food|feed|feeding|meal|vitamin|hydration|hydrate|breastfeed|breastfeeding|weaning|solids|wean)\b/;
  function nutritionBlock() {
    if (!E.nutri || !E.lastText) return "";
    const t = E.lastText;
    if (!NUTRI_INTENT.test(t)) return "";
    let hits = (E.nutri.guides || []).filter(x => (x.phrases || []).some(p => t.indexOf(norm(p).trim()) >= 0));
    // if nutrition intent but no stage named, use the profile's age to pick the stage
    if (!hits.length && E.profile.ageYears != null && E.nutri.guides) {
      const ay = E.profile.ageYears, row = NUTRI_BY_AGE.find(r => ay >= r[0] && ay < r[2]);
      if (row) { const g = E.nutri.guides.find(x => x.id === row[1]); if (g) hits = [g]; }
    }
    if (!hits.length) return "";
    let html = `<div class="blk"><div class="htag">Nutrition guide</div>`;
    for (const n of hits.slice(0, 2)) {
      html += `<div class="cand routine"><div class="cname">${esc(n.stage)} <span class="band possible">${esc(n.age_range)}</span></div>`;
      if (n.summary) html += `<div class="act">${esc(n.summary)}</div>`;
      if (n.key_nutrients && n.key_nutrients.length) html += `<div class="act"><b>Focus on:</b> ${esc(n.key_nutrients.join("; "))}</div>`;
      if (n.hydration) html += `<div class="act"><b>Drinks:</b> ${esc(n.hydration)}</div>`;
      if (n.safety) html += `<div class="act"><b>Safety:</b> ${esc(n.safety)}</div>`;
      if (n.supplements && n.supplements !== "N/A") html += `<div class="act"><b>Supplements:</b> ${esc(n.supplements)}</div>`;
      if (n.when_to_see_care) html += `<div class="watch"><b>See care for:</b> ${esc(n.when_to_see_care)}</div>`;
      html += `<div class="ref"><span class="src">${esc(n.source || "")}</span></div></div>`;
    }
    html += `</div>`;
    return html;
  }

  // Parse measured results (vitals/labs) from text; deterministic. Sets symptoms too.
  function parseVitals(t) {
    if (!E.exam || !E.exam.vitals) return { rows: [], syms: [] };
    const rows = [], syms = [];
    let bpSys = null;
    const bpm = t.match(/(?:blood pressure|bp)\D{0,6}(\d{2,3})\s*(?:\/|over)\s*(\d{2,3})/) || t.match(/\b(\d{2,3})\s*(?:\/|over)\s*(\d{2,3})\b/);
    if (bpm) bpSys = parseInt(bpm[1], 10);
    for (const v of E.exam.vitals) {
      let val = null;
      if (v.id === "bp_sys") { if (bpSys != null) val = bpSys; }
      else {
        for (const nm of v.names.split(",").map(s => s.trim()).filter(Boolean)) {
          const m = t.match(new RegExp(escRe(nm) + "\\D{0,8}(\\d{1,3}(?:\\.\\d)?)"));
          if (m) { val = parseFloat(m[1]); break; }
        }
      }
      if (val == null || isNaN(val)) continue;
      if (v.id === "temp" && val > 45) val = Math.round(((val - 32) * 5 / 9) * 10) / 10; // °F→°C
      if (v.id === "glucose" && val > 30) val = Math.round((val / 18) * 10) / 10;         // mg/dL→mmol/L
      const band = (v.bands || []).find(b => (b.min == null || val >= b.min) && (b.max == null || val <= b.max));
      if (!band) continue;
      rows.push({ name: v.name, value: val, unit: v.unit, label: band.label, urgency: band.urgency || "", note: v.note });
      for (const s of (band.sym || [])) syms.push(s);
    }
    return { rows, syms };
  }

  function vitalsBlock(rows) {
    if (!rows || !rows.length) return "";
    let html = `<div class="blk"><div class="htag">Results entered — what they mean</div>`;
    for (const r of rows) {
      const uc = r.urgency ? ("u-" + r.urgency) : "";
      html += `<div class="webitem"><b>${esc(r.name)}: ${esc(String(r.value))}</b> — <span class="${uc}">${esc(r.label)}</span><div class="ref"><span class="src">${esc(r.note || "")}</span></div></div>`;
    }
    html += `</div>`;
    return html;
  }

  // Guided examination — "how to check X, what to look for".
  function examBlock() {
    if (!E.exam || !E.lastText) return "";
    const t = E.lastText;
    const hits = (E.exam.exams || []).filter(x => (x.triggers || []).some(p => t.indexOf(norm(p).trim()) >= 0));
    if (!hits.length) return "";
    let html = `<div class="blk exam"><div class="htag">How to check — guided exam</div>`;
    for (const e of hits.slice(0, 1)) {
      html += `<div class="cand routine"><div class="cname">${esc(e.region)}</div>`;
      html += `<div class="act"><b>How:</b> ${esc(e.how)}</div>`;
      if (e.look_for && e.look_for.length) html += `<div class="act"><b>Look for:</b><ul class="lookfor">` + e.look_for.map(x => `<li>${esc(x)}</li>`).join("") + `</ul></div>`;
      if (e.red_flags && e.red_flags.length) html += `<div class="watch"><b>Get emergency help for:</b> ${esc(e.red_flags.join("; "))}</div>`;
      if (e.photo) html += `<div class="ref"><b>Photo tip:</b> ${esc(e.photo)}</div>`;
      html += `<div class="act" style="margin-top:6px"><b>Then tell me what you see</b> — I'll factor it in.</div></div>`;
    }
    html += `</div>`;
    return html;
  }

  // Anatomy + physiology ("how the body works") reference lookup.
  // Only when the person is explicitly asking to LEARN — never on a symptom report.
  const KNOW_INTENT = /\b(explain|what is|what are|what does|whats|how does|how do|how the body|tell me about|teach me|show me|anatomy|physiology|histolog|learn about|describe the)\b/;
  function knowledgeBlock() {
    if (!E.lastText || !KNOW_INTENT.test(E.lastText)) return "";
    const t = E.lastText; let body = "";
    if (E.anat && E.anat.systems) {
      for (const e of E.anat.systems.filter(x => (x.phrases || []).some(ph => t.indexOf(norm(ph).trim()) >= 0)).slice(0, 1)) {
        body += `<div class="cand routine"><div class="cname">${esc(e.title)} <span class="band possible">anatomy</span></div>`;
        body += `<div class="act">${esc(e.overview)}</div>`;
        if (e.structures && e.structures.length) body += `<div class="act"><b>Key parts:</b><ul class="lookfor">` + e.structures.map(s => `<li><b>${esc(s.name)}:</b> ${esc(s.detail)}</li>`).join("") + `</ul></div>`;
        if (e.normal) body += `<div class="act"><b>Normal:</b> ${esc(e.normal)}</div>`;
        if (e.common_problems && e.common_problems.length) body += `<div class="watch"><b>Common problems:</b> ${esc(e.common_problems.join("; "))}</div>`;
        body += `<div class="ref"><span class="src">${esc(e.source || "")}</span></div></div>`;
      }
    }
    if (E.phys && E.phys.processes) {
      for (const e of E.phys.processes.filter(x => (x.phrases || []).some(ph => t.indexOf(norm(ph).trim()) >= 0)).slice(0, 1)) {
        body += `<div class="cand routine"><div class="cname">${esc(e.topic)} <span class="band possible">how it works</span></div>`;
        body += `<div class="act">${esc(e.how_it_works)}</div>`;
        if (e.timing) body += `<div class="act"><b>Timing / the body clock:</b> ${esc(e.timing)}</div>`;
        if (e.why_it_matters) body += `<div class="watch"><b>Why it matters:</b> ${esc(e.why_it_matters)}</div>`;
        body += `<div class="ref"><span class="src">${esc(e.source || "")}</span></div></div>`;
      }
    }
    if (E.histo && E.histo.entries) {
      for (const e of E.histo.entries.filter(x => (x.phrases || []).some(ph => t.indexOf(norm(ph).trim()) >= 0)).slice(0, 1)) {
        body += `<div class="cand routine"><div class="cname">${esc(e.topic)} <span class="band possible">sliced to the cell</span></div>`;
        if (e.scale) body += `<div class="act"><b>Zoom:</b> ${esc(e.scale)}</div>`;
        if (e.layers && e.layers.length) body += `<div class="act"><b>Layers:</b><ul class="lookfor">` + e.layers.map(l => `<li><b>${esc(l.level)}:</b> ${esc(l.detail)}</li>`).join("") + `</ul></div>`;
        if (e.function) body += `<div class="act"><b>Function:</b> ${esc(e.function)}</div>`;
        if (e.clinical) body += `<div class="watch"><b>When it goes wrong:</b> ${esc(e.clinical)}</div>`;
        body += `<div class="ref"><span class="src">${esc(e.source || "")}</span></div></div>`;
      }
    }
    if (!body) return "";
    return `<div class="blk"><div class="htag">How the body works — reference</div>` + body + `</div>`;
  }

  // ---- Medicines & history: extra profile variables (deterministic) ----
  function buildMedIndex() {
    E.medSyn = [];
    if (!E.meds || !E.meds.drugs) return;
    for (const id of Object.keys(E.meds.drugs)) {
      const d = E.meds.drugs[id];
      for (const s of (d.syn || [])) {
        const w = norm(s).trim().split(/\s+/).filter(Boolean).map(escRe);
        if (!w.length) continue;
        E.medSyn.push({ re: new RegExp("(?:^|\\s)" + w.join("\\s+") + "(?:\\s|$)"), id: id });
      }
    }
  }
  function parseMeds(t) {
    const found = [];
    if (E.medSyn) for (const m of E.medSyn) { m.re.lastIndex = 0; if (m.re.test(t) && found.indexOf(m.id) < 0) found.push(m.id); }
    return found;
  }
  // Only put a medicine on the person's list when they say they take it. A question about a
  // medicine ("what is metformin") is a request for information, not a statement of use.
  const MED_TAKE = /\b(i take|i m on|im on|i am on|taking|i use|i m using|using|prescribed|my meds|my medicines?|my medications?|my pills|my tablets|i was given|started|been on|put me on|she takes|he takes|takes|is on)\b/;
  const MED_INFO = /\b(what is|what are|whats|what s|tell me about|explain|side effects?|used for|look like|looks like|picture|photo|show me|info|information|define|meaning|how does)\b/;
  // Safety intents. A question about dying from, or getting high on, a medicine is never answered
  // with amounts; it gets crisis or harm-reduction help instead, and nothing is added to the list.
  const SELF_HARM_RX = /\b(kill (me|myself|him|her|you|someone)|end my life|end it all|suicid\w*|want to die|wanna die|take my (own )?life|lethal|fatal (dose|amount|overdose)|deadly (dose|amount)|overdose on purpose|(how (much|many)|what (dose|amount)|which (dose|amount)) .{0,70}(die|dying|kill|fatal|lethal|deadly|overdose))\b/;
  const MISUSE_RX = /\b(get(s|ting)? (you |me |us )?high|to get high|high off|recreational\w*|to trip|get a buzz|get buzzed|snort\w*|shoot (it )?up|inject it|parachut\w*|plug it|rail it|nod off on|robotrip\w*|lean|potentiat\w*)\b/;
  const INGEST_RX = /\b(swallow\w*|ate|eaten|drank|drunk|chewed|got into|ingested|took|taken)\b.{0,80}\b(pills?|tablets?|capsules?|medicines?|medications?|meds|patch(es)?|gummies|vitamins|iron tablets|drops|syrup|inhaler|cream|ointment)\b/;
  const INGEST_WHO_RX = /\b(child|kid|toddler|baby|infant|son|daughter|grandson|granddaughter|grandchild|niece|nephew|boy|girl|pet|dog|cat|puppy|kitten|accident\w*|by mistake|mistakenly|too many|whole bottle|entire bottle|wrong (pill|tablet|medicine|medication|dose)|double dose|twice|someone else s|not (his|hers|mine|theirs)|grandma|grandpa|grandmother|grandfather|nana|mom s|dad s|mum s)\b/;
  function medsToRecord(t) {
    if (SELF_HARM_RX.test(t) || MISUSE_RX.test(t)) return [];
    if (INGEST_WHO_RX.test(t) && /\b(swallow\w*|ate|eaten|got into|ingested|chewed)\b/.test(t)) return [];   // someone else's accident, not this person's own medicine list
    const found = parseMeds(t); if (!found.length) return found;
    if (MED_TAKE.test(t)) return found;
    if (MED_INFO.test(t)) return [];
    return found.filter(id => E.meds.drugs[id] && E.meds.drugs[id].cls !== "other");
  }
  const HISTORY_MAP = [
    ["diabetes", /\b(diabetes|diabetic|t1dm|t2dm)\b/],
    ["high blood pressure", /\b(high blood pressure|hypertension|hypertensive)\b/],
    ["asthma", /\basthma(tic)?\b/],
    ["COPD", /\b(copd|emphysema)\b/],
    ["heart disease", /\b(heart disease|coronary|previous heart attack|heart failure|atrial fibrillation|afib)\b/],
    ["kidney disease", /\b(kidney disease|chronic kidney|ckd|on dialysis)\b/],
    ["liver disease", /\b(liver disease|cirrhosis)\b/],
    ["previous stroke", /\b(previous stroke|had a stroke|prior tia)\b/],
    ["cancer history", /\b(cancer|in remission|had chemo)\b/],
    ["thyroid condition", /\b(thyroid|hypothyroid|hyperthyroid)\b/],
    ["epilepsy", /\b(epilepsy|seizure disorder)\b/],
    ["depression/anxiety", /\b(depression|anxiety disorder|bipolar)\b/],
    ["immune-suppressed", /\b(immunosuppress|immunocompromised|transplant|hiv positive)\b/]
  ];
  function parseHistory(t) {
    const ctx = /\b(history of|diagnosed|known|i have|i've had|ive had|suffer from|chronic|background of|i'?m (a )?(diabetic|asthmatic|hypertensive|epileptic))\b/.test(t);
    const out = [];
    for (const [tag, re] of HISTORY_MAP) { if (re.test(t) && ctx) out.push(tag); }
    return out;
  }
  function mergeProfileList(key, items) {
    if (!items || !items.length) return;
    E.profile[key] = E.profile[key] || [];
    for (const x of items) if (E.profile[key].indexOf(x) < 0) E.profile[key].push(x);
  }

  // Interaction + duplicate check over a list of canonical drug ids.
  function medsPresentSets(ids) {
    const dset = new Set(), cset = new Set(), byCls = {};
    for (const id of ids) { const d = E.meds && E.meds.drugs[id]; if (!d) continue; dset.add(id); cset.add(d.cls); (byCls[d.cls] = byCls[d.cls] || []).push(id); }
    return { dset, cset, byCls };
  }
  function medsCheck(ids) {
    const flags = [], dups = [];
    if (!E.meds) return { flags, dups };
    const S = medsPresentSets(ids);
    const sideDrugs = (ep) => ep.indexOf("drug:") === 0 ? (S.dset.has(ep.slice(5)) ? [ep.slice(5)] : []) : ids.filter(x => E.meds.drugs[x] && E.meds.drugs[x].cls === ep.slice(4));
    for (const it of (E.meds.interactions || [])) {
      const A = sideDrugs(it.a), B = sideDrugs(it.b);
      if (!A.length || !B.length) continue;
      if (new Set(A.concat(B)).size < 2) continue; // need two distinct medicines
      flags.push({ sev: it.severity, a: A, b: B, effect: it.effect, advice: it.advice });
    }
    for (const cls of Object.keys(E.meds.duplicate_classes || {})) {
      const uniq = [...new Set(S.byCls[cls] || [])];
      if (uniq.length >= 2) dups.push({ cls, label: E.meds.duplicate_classes[cls], drugs: uniq });
    }
    const SV = { contraindicated: 0, major: 1, moderate: 2 };
    flags.sort((x, y) => (SV[x.sev] - SV[y.sev]) || (x.a[0] < y.a[0] ? -1 : 1));
    return { flags, dups };
  }
  function medName(id) { return (E.meds && E.meds.drugs[id]) ? E.meds.drugs[id].name : id; }
  function medsBlock() {
    if (!E.meds || !E.profile.meds || !E.profile.meds.length) return "";
    const ids = E.profile.meds;
    const { flags, dups } = medsCheck(ids);
    const SEVCLS = { contraindicated: "emergency", major: "urgent", moderate: "prompt" };
    const SEVLAB = E.meds.severity_label || {};
    let html = `<div class="blk meds"><div class="htag">Medicines on file — safety check</div>`;
    html += `<div class="webitem">${ids.map(id => esc(medName(id))).join(" · ")}</div>`;
    // One line per pair of medicines: if two rules match the same pair, keep the most severe.
    const SEVRANK = { contraindicated: 3, major: 2, moderate: 1 };
    const bestByPair = new Map();
    for (const f of flags) {
      const key = [...new Set(f.a.concat(f.b))].map(id => medName(id)).sort().join(" + ");
      const prev = bestByPair.get(key);
      if (!prev || (SEVRANK[f.sev] || 0) > (SEVRANK[prev.sev] || 0)) bestByPair.set(key, f);
    }
    const shownFlags = [...bestByPair.values()];
    for (const f of shownFlags) {
      const names = [...new Set(f.a.concat(f.b))].map(id => esc(medName(id))).join(" + ");
      html += `<div class="cand ${SEVCLS[f.sev] || "prompt"}"><div class="cname">${names} <span class="band weak">${esc(SEVLAB[f.sev] || f.sev)}</span></div><div class="act">${esc(f.effect)}.</div><div class="watch">${esc(f.advice)}</div></div>`;
    }
    for (const d of dups) {
      html += `<div class="cand prompt"><div class="cname">${esc(d.label)} <span class="band weak">Duplicate</span></div><div class="act">You appear to have more than one: ${d.drugs.map(id => esc(medName(id))).join(", ")}. Different doctors sometimes prescribe the same type without knowing about the other.</div><div class="watch">Ask your pharmacist or doctor to confirm you should be on both.</div></div>`;
    }
    if (E.meds.same_ingredient_note && ids.indexOf("paracetamol") >= 0) html += `<div class="ref">${esc(E.meds.same_ingredient_note.paracetamol)}</div>`;
    // Food & grapefruit flags for the medicines actually on file
    const D = E.meds.drugs || {};
    const gfOn = ids.filter(id => D[id] && D[id].grapefruit);
    const foodNotes = [];
    for (const id of ids) {
      const d = D[id]; if (!d) continue;
      if (d.with_food) foodNotes.push(`<b>${esc(d.name)}</b>: take with food (less stomach upset).`);
      if (d.empty_stomach) foodNotes.push(`<b>${esc(d.name)}</b>: take on an empty stomach (with water).`);
      if (d.separate_from) foodNotes.push(`<b>${esc(d.name)}</b>: keep apart from ${esc(d.separate_from)}.`);
      if (d.food_note) foodNotes.push(`<b>${esc(d.name)}</b>: ${esc(d.food_note)}`);
    }
    if (gfOn.length && E.meds.food && E.meds.food.grapefruit) {
      html += `<div class="cand prompt"><div class="cname">Grapefruit <span class="band weak">Food caution</span></div><div class="act">${esc(E.meds.food.grapefruit.what)}</div><div class="watch">Flagged on your list: ${gfOn.map(id => esc(D[id].name)).join(", ")}. ${esc(E.meds.food.grapefruit.advice)}</div></div>`;
    }
    if (foodNotes.length) html += `<div class="blk"><div class="htag">Food & timing for your medicines</div>${foodNotes.map(n => `<div class="webitem">${n}</div>`).join("")}<div class="ref">General label patterns — your leaflet or pharmacist gives the exact instruction for your version.</div></div>`;
    const unk = ids.filter(id => D[id] && D[id].cls === "other");
    if (unk.length) html += `<div class="cand prompt"><div class="cname">${unk.map(id => esc(D[id].name)).join(", ")} <span class="band weak">Not in the interaction checker</span></div><div class="watch">${esc(E.meds.unclassified_note || "No interaction rules are held for this medicine — ask a pharmacist to check your whole list.")}</div></div>`;
    if (!shownFlags.length && !dups.length) html += `<div class="act">No well-known serious interaction flagged among these. This is a limited reference check and can't catch everything — a pharmacist review is still worthwhile, especially with more than one prescriber.</div>`;
    html += `<div class="ref"><span class="src">${esc(E.meds.safety || "Reference safety-net only — never start, stop or change a medicine based on this.")}</span></div></div>`;
    return html;
  }

  // ---- Care plans: typical pathway from check-up to recovery ----
  const TREAT_INTENT = /\b(treat\w*|cure\w*|remed\w*|heal\w*|manag\w*|medication|medicine|how long|recover|recovery|get better|getting better|follow up|follow-up|followup|check in|check-in|care plan|what do i do|what should i do|next step|fix this|fix it)\b/;
  function namedConditions(t) {
    const out = [], tt = " " + t + " ";
    for (const c of E.map.conditions) {
      const idw = norm(c.id.replace(/_/g, " ")).trim();
      const nm = norm(c.name.replace(/\(.*?\)/g, "")).trim();
      for (const k of [idw, nm]) { if (k && k.length >= 3 && tt.indexOf(" " + k + " ") >= 0 && out.indexOf(c.id) < 0) out.push(c.id); }
    }
    return out;
  }
  function planFor(id) {
    const c = E.condById[id]; if (!c) return null;
    const sp = (E.plans && E.plans.plans) ? E.plans.plans[id] : null;
    const order = (E.plans && E.plans.stage_order) || ["confirm", "treatment", "duration", "side_effects", "followup", "recovery"];
    const lab = (E.plans && E.plans.stage_labels) || {};
    let stages;
    if (sp) stages = order.map(k => [lab[k] || k, sp[k]]).filter(x => x[1]);
    else stages = [
      [lab.confirm || "Confirming what it is", "A clinician confirms this with an exam and any tests that fit the picture."],
      [lab.treatment || "Typical treatment", c.action || "Treatment depends on the exact cause your clinician finds."],
      [lab.duration || "How long it usually takes", "Recovery time depends on the cause and how early it's treated."],
      [lab.side_effects || "Possible side effects of treatment", "Any medicine can have side effects — follow your label and ask your pharmacist."],
      [lab.followup || "Follow-up & check-ins", "Urgency here: " + (URG_LABEL[c.urgency] || "") + ". Check back if it isn't improving as expected."],
      [lab.recovery || "Recovery — and when it's over", c.red ? ("Seek care sooner if: " + c.red) : "You're recovered when symptoms settle and normal function returns."]
    ];
    return { c, stages, generic: !sp };
  }
  function carePlanBlock(rows) {
    if (!E.lastText || !TREAT_INTENT.test(E.lastText)) return "";
    let targets = namedConditions(E.lastText).slice(0, 2);
    if (!targets.length) targets = rows.slice(0, 1).map(r => r.c.id);
    if (!targets.length) return "";
    let html = `<div class="blk plan"><div class="htag">Care plan — from check-up to recovery</div>`;
    const gnote = (E.plans && E.plans.generic_note) || "";
    for (const id of targets) {
      const pf = planFor(id); if (!pf) continue;
      html += `<div class="cand ${pf.c.urgency}"><div class="cname">${esc(pf.c.name)} <span class="band ${pf.generic ? "weak" : "possible"}">${pf.generic ? "general shape" : "typical pathway"}</span></div>`;
      if (pf.generic && gnote) html += `<div class="act muted">${esc(gnote)}</div>`;
      for (const [l, txt] of pf.stages) html += `<div class="act"><b>${esc(l)}:</b> ${esc(txt)}</div>`;
      html += `</div>`;
    }
    html += `<div class="ref"><span class="src">${esc((E.plans && E.plans.safety) || "Typical pathways for education only — your clinician sets your actual plan.")}</span></div></div>`;
    return html;
  }

  // ---- Session summary for sharing with a real clinician (plain text) ----
  function summary() {
    const L = [], d = new Date(), pad = n => (n < 10 ? "0" : "") + n;
    const date = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    const rule = "===================================================";
    L.push("HIVE DOCTOR — SESSION SUMMARY");
    L.push("Generated " + date);
    L.push("Reference / triage only — NOT a diagnosis or prescription. Shared for your clinician to review.");
    L.push(rule);
    const p = E.profile || {}, pl = [];
    if (p.ageMonths != null && p.ageMonths < 24) pl.push(p.ageMonths + " month(s) old");
    else if (p.ageYears != null) pl.push(p.ageYears + " years");
    if (p.sex) pl.push(p.sex);
    if (p.heightCm) pl.push(p.heightCm + " cm");
    if (p.weightKg) pl.push(p.weightKg + " kg");
    if (p.bmi) pl.push("BMI " + p.bmi + " (" + p.bmiCat + ")");
    if (p.pregnant === true) pl.push("pregnant");
    L.push("");
    L.push("PROFILE: " + (pl.length ? pl.join(", ") : "not provided"));
    if (p.history && p.history.length) L.push("MEDICAL HISTORY: " + p.history.join(", "));
    if (p.meds && p.meds.length) {
      L.push("MEDICINES ON FILE: " + p.meds.map(medName).join(", "));
      const { flags, dups } = medsCheck(p.meds);
      if (flags.length || dups.length) {
        L.push("  Medication flags to review with a pharmacist/doctor:");
        for (const f of flags) L.push("   - [" + f.sev + "] " + [...new Set(f.a.concat(f.b))].map(medName).join(" + ") + ": " + f.effect);
        for (const dd of dups) L.push("   - [duplicate] " + dd.label + ": " + dd.drugs.map(medName).join(", "));
      }
    }
    const presLabels = [...E.present].map(s => E.map.symptoms[s] ? E.map.symptoms[s].label : s);
    const absLabels = [...E.absent].map(s => E.map.symptoms[s] ? E.map.symptoms[s].label : s);
    L.push("");
    L.push("REPORTED: " + (presLabels.length ? presLabels.join(", ") : "(none captured)"));
    if (absLabels.length) L.push("DENIED / NOT PRESENT: " + absLabels.join(", "));
    if (E.lastVitals && E.lastVitals.length) L.push("MEASUREMENTS: " + E.lastVitals.map(r => r.name + " " + r.value + " (" + r.label + ")").join("; "));
    const flags = redflagHits();
    if (flags.length) { L.push(""); L.push("URGENT SAFETY FLAGS:"); for (const f of flags) L.push("   ! " + (f.msg || f.id)); }
    const rows = score();
    L.push("");
    L.push("POSSIBLE CAUSES TO CONSIDER (ranked, reference only):");
    if (rows.length) for (const r of rows.slice(0, 10)) { const bl = { strong: "most consistent", possible: "possible", weak: "less likely" }[r.band]; L.push("   - " + r.c.name + "  [" + bl + " · " + r.c.urgency + "]"); }
    else L.push("   (not enough detail captured to rank causes)");
    L.push("");
    L.push(rule);
    L.push("Produced by a deterministic reference tool to support a conversation with a real clinician. Not a medical record, diagnosis, or treatment plan. Medicines: follow your label and prescriber. Emergencies: call your local number (911/112/999).");
    return L.join("\n");
  }

  // ---- Conversational layer: deterministic, but fluent and varied ----
  function hash(s) { let h = 2166136261; s = s || ""; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function vpick(arr, seed) { return arr[hash(String(seed)) % arr.length]; }
  function wrapMsg(txt) { return `<div class="blk"><p>${esc(txt)}</p></div>`; }
  const GREET = ["Hi — good to see you.", "Hello.", "Hey there.", "Hi."];
  const INVITE = ["What's going on with you today?", "Tell me what's bothering you and I'll help you make sense of it.", "What can I help you figure out?", "What's on your mind, health-wise?"];
  const THANKS = ["Anytime — I'm glad it helped.", "You're welcome. I'm here whenever you need me.", "Of course. Look after yourself."];
  const IDENTITY = "I'm HIVE Doctor — a private helper that runs right on your device. I can talk through symptoms, line up what might be going on and how urgent it is, explain conditions, treatments and medicines, and tell you when something needs a real doctor. I'm here to help you understand and decide — not to replace your own doctor.";
  const BYE = ["Take care of yourself — come back anytime.", "Look after yourself. I'm here whenever you need me.", "Be well. You can pick this up again anytime."];
  const REASSURE = ["I hear you — it's okay to feel worried, and reaching out is a good step.", "That sounds stressful. Let's take it one step at a time, together.", "It makes sense to be concerned. We'll work through it calmly."];
  const NUDGE = ["Whenever you're ready — tell me a bit more.", "Go on, I'm listening.", "Take your time. What else are you noticing?"];
  const CLARIFY = ["Let me put it simply — what's the main thing bothering you, and where in your body is it?", "No problem. Just tell me what feels wrong and when it started, in your own words.", "Happy to rephrase — what's the biggest symptom you're dealing with right now?"];
  const LEAD = ["Okay —", "Thanks for telling me —", "Got it —", "Alright —"];
  const EMPTY = ["I'm here to help. Tell me what's bothering you most — for example a pain (and where), a fever, feeling sick, a cough, dizziness, or a rash — and when it started.", "I'm here with you. Let's start with the main thing — a pain somewhere, feeling unwell, a fever, a cough, a rash, or something that just feels off — what are you noticing, and since when?", "I'm here, and I'm listening. In your own words, what's the biggest problem right now — where it is, when it began, and how it feels?", "I'm here to help you make sense of it. Tell me what's going on — the main symptom (a pain, a fever, feeling sick, a cough, a rash, anything) and roughly when it started."];
  const ASKLEAD = ["One thing would help me narrow this down:", "Can I ask —", "To zero in a little:", "A quick question:"];
  const WORRY = /\b(scared|worried|afraid|anxious|nervous|terrified|frightened|freaking out|panicking)\b/;
  const EMERG_EMPATHY = ["I know this is frightening — let's focus on what to do right now.", "I'm here with you — this needs quick action, so stay as calm as you can and follow these steps.", "I'm here with you — the most important thing now is getting help fast."];
  const CHILD_EMPATHY = ["It's worrying when your little one is unwell — let's work through it together.", "You're doing the right thing by checking. Here's what matters most.", "I know it's stressful when it's your child — let's take it step by step."];
  const ESCALATE = ["If it helps, just tell me the body part and what it feels like — for example 'pain in my lower belly' or 'burning when I pee'.", "In a few words: where is it, and what does it feel like — sharp, dull, burning, or throbbing?", "Let's keep it simple — name the main body part and one word for how it feels."];
  const CHILD = /\b(baby|infant|newborn|my (son|daughter|kid|child|little one|toddler)|my \d+ ?(month|year|yr|mo)s? ?(old)?)\b/;

  // Handle a conversational turn. Returns reply HTML, or null to fall through to clinical.
  // Would the Support & safety block fire for the current text? If so, small-talk must never
  // short-circuit it — a safeguarding disclosure always reaches support, not a chit-chat reply.
  function supportWouldFire() {
    if (!E.support || !E.lastText) return false;
    const tt = E.lastText;
    const hit = (arr) => (arr || []).some(x => tt.indexOf(norm(x).trim()) >= 0);
    if (hit(E.support.danger_triggers)) return true;
    for (const c of (E.support.categories || [])) { if (hit(c.triggers)) return true; }
    return false;
  }
  function smallTalk(raw) {
    const t = (raw || "").toLowerCase().trim();
    const seed = raw + "|" + E.turns;
    if (supportWouldFire()) return null;
    // "pass / skip" the question we just asked
    if (E.lastAskSym && /^(pass|skip|prefer not|rather not|don'?t know|dunno|not sure|no idea|next)\b/.test(t)) {
      E.asked.add(E.lastAskSym); E.lastAskSym = null; E.lastText = norm(raw);
      return wrapMsg(vpick(["No problem, we'll skip that.", "That's okay — moving on.", "Sure, we can leave that one."], seed)) + compose();
    }
    // yes / no answering the last question we asked
    if (E.lastAskSym && /^(yes|yeah|yep|yup|ya|i do|i have|correct|that'?s right|definitely|sure do|uh ?huh|mhm)\b/.test(t)) {
      const s = E.lastAskSym; E.present.add(s); E.absent.delete(s); E.lastAskSym = null; E.lastText = norm(raw);
      return wrapMsg(vpick(["Got it.", "Okay, thanks.", "Noted."], seed)) + compose();
    }
    if (E.lastAskSym && /^(no|nope|nah|not really|i don'?t|negative|none|uh ?uh)\b/.test(t)) {
      const s = E.lastAskSym; E.absent.add(s); E.present.delete(s); E.lastAskSym = null; E.lastText = norm(raw);
      return wrapMsg(vpick(["Okay — good to rule out.", "Noted, thanks.", "Alright."], seed)) + compose();
    }
    // only treat as pure chit-chat when there's no actual symptom in the message
    if (extract(raw).present.size) return null;
    if (/^(hi+|hello|hey+|yo|hiya|howdy|good (morning|afternoon|evening)|greetings|sup)\b/.test(t)) return wrapMsg(vpick(GREET, seed) + " " + vpick(INVITE, seed));
    if (/\b(thank you|thanks|thx|appreciate it|^ty)\b/.test(t)) return wrapMsg(vpick(THANKS, seed));
    if (/\b(who are you|what are you|what can you do|how do you work|are you (a )?(doctor|real|human|bot|ai|robot))\b/.test(t)) return wrapMsg(IDENTITY);
    if (/\b(bye|goodbye|good ?night|see ya|see you|that'?s all|that is all|take care)\b/.test(t)) return wrapMsg(vpick(BYE, seed));
    if (WORRY.test(t)) return wrapMsg(vpick(REASSURE, seed)) + (E.present.size ? compose() : wrapMsg(vpick(INVITE, seed)));
    if (/\b(what do you mean|i don'?t understand|confused|come again|pardon|huh)\b/.test(t)) return wrapMsg(vpick(CLARIFY, seed));
    if (t.split(/\s+/).length <= 3 && /^(ok|okay|alright|k|cool|sure|got it|i see|right|hmm|yeah)\b/.test(t)) return wrapMsg(vpick(NUDGE, seed));
    return null;
  }

  // Abuse recognition & victim support — protective, victim-facing, resource-first.
  // Deterministic, offline. Shown prominently; never mixed into the medical differential.
  function supportBlock() {
    if (!E.support || !E.lastText) return "";
    const t = E.lastText;
    const hit = (arr) => (arr || []).some(p => t.indexOf(norm(p).trim()) >= 0);
    const danger = hit(E.support.danger_triggers);
    let cat = null;
    for (const c of (E.support.categories || [])) { if (hit(c.triggers)) { cat = c; break; } }
    if (!danger && !cat) return "";
    if (!E.supportShown) E.supportShown = new Set();
    const _key = cat ? cat.id : "danger";
    const _seen = E.supportShown.has(_key);
    E.supportShown.add(_key);
    let html = `<div class="blk emerg"><div class="htag">Support &amp; safety</div>`;
    if (danger) html += `<p><b>${esc(E.support.danger_msg)}</b></p>`;
    if (cat) {
      if (!_seen) {
        html += `<p><b>${esc(cat.title)}</b></p><p>${esc(cat.validation)}</p>`;
        if (cat.markers && cat.markers.length) html += `<div class="ref"><span class="src">Things to watch for: ${cat.markers.map(esc).join("; ")}.</span></div>`;
        if (cat.steps && cat.steps.length) { html += `<div class="htag">What can help</div><ul>` + cat.steps.map(s => `<li>${esc(s)}</li>`).join("") + `</ul>`; }
        if (cat.resources && cat.resources.length) { html += `<div class="htag">Confidential help</div><ul>` + cat.resources.map(r => `<li>${esc(r)}</li>`).join("") + `</ul><div class="ref"><span class="src">${esc(E.support.resources_note)}</span></div>`; }
        html += `<p>${esc(E.support.closing)}</p>`;
      } else {
        const REMIND = [
          "The guidance and confidential helplines above still apply — you can come back to them any time, and reaching out does not commit you to anything.",
          "What you've shared still matters, and none of it is your fault. The steps and helplines above are there whenever you're ready.",
          "I'm still here with you. The support options above remain the safest next step — talking to someone does not commit you to anything.",
          "You're not alone in this. The confidential help listed above is available any time you want it."
        ];
        E.supportRemindN = (E.supportRemindN || 0) + 1;
        html += `<p><b>${esc(cat.title)}</b></p><p>${esc(REMIND[E.supportRemindN % REMIND.length])}</p>`;
      }
    }
    return html + `</div>`;
  }

  // Build the deterministic reply HTML for the current state.
  const GRADE_RANK = { emergency: 5, urgent: 4, prompt: 3, routine: 2, selfcare: 1 };
  // Deterministic triage grade: Score/100 (0 = a scrape/bump/freckle, 100 = widest/most serious),
  // Urgency/10 (how fast to act) and Severity/10 (how serious), from red flags + the top tier shown.
  function computeGrade(flags, groups) {
    const flagged = !!(flags && flags.length);
    let rank = 0;
    for (const f of (flags || [])) rank = Math.max(rank, GRADE_RANK[f.urgency] || 0);
    // headline = the first (highest-urgency) condition actually shown to the user
    let head = null;
    if (groups && groups.length && groups[0].rows && groups[0].rows.length) head = groups[0].rows[0];
    if (head) rank = Math.max(rank, GRADE_RANK[(head.c && head.c.urgency)] || 0);
    if (!rank) return { score: 0, sev: 0, urg: 0, label: "None identified yet" };
    const SEV = { 5: 10, 4: 8, 3: 6, 2: 4, 1: 2 };
    const URG = { 5: 10, 4: 7, 3: 5, 2: 3, 1: 2 };
    let sev = SEV[rank], urg = URG[rank];
    // A red flag anchors the grade to its OWN tier (emergency -> 10/10; urgent -> 8/7; etc.),
    // not automatically to Critical. Only a true emergency-tier flag pins it to 9+.
    if (!flagged && head) { // lower confidence pulls the grade down (no red flag to anchor it)
      const adj = head.band === "weak" ? 2 : (head.band === "possible" ? 1 : 0);
      sev = Math.max(1, sev - adj); urg = Math.max(1, urg - adj);
    }
    sev = Math.max(0, Math.min(10, sev)); urg = Math.max(0, Math.min(10, urg));
    const score = Math.max(0, Math.min(100, Math.round(sev * 6 + urg * 4)));
    const label = score >= 76 ? "Critical" : score >= 56 ? "Serious" : score >= 36 ? "Moderate" : score >= 16 ? "Mild" : "Minimal";
    return { score, sev, urg, label };
  }
  function gradeBand(g) {
    if (!g || !g.score) return "";
    return `<div class="blk grade"><div class="htag">Triage grade</div>`
      + `<p><b>Score ${g.score}/100</b> &middot; Urgency ${g.urg}/10 &middot; Severity ${g.sev}/10 &mdash; ${esc(g.label)}</p>`
      + `<div class="ref"><span class="src">A compact guide, not a diagnosis: 0 means minor (a scrape, bump or freckle), 100 means the widest and most serious. Based on what you've told me so far &mdash; it updates as you add detail.</span></div></div>`;
  }

  function specialistFor(c) {
    if (!E.specialists || !c) return "";
    const ov = (E.specialists.overrides || {})[c.id];
    if (ov) return ov;
    return (E.specialists.by_system || {})[c.system] || (E.specialists.by_system || {}).general || "";
  }

  // Real, substantive guidance for a recognised symptom that has no narrowed cause yet:
  // common causes, red flags that mean urgent care, and simple self-care. Deterministic,
  // read from the symptom map (causes/watch/care). Turns "noted it, tell me more" into content.
  function symptomGuideBlock(sid) {
    const sym = (E.map.symptoms && E.map.symptoms[sid]) || null;
    if (!sym || !(sym.causes || sym.watch || sym.care)) return "";
    let html = `<div class="blk"><div class="htag">About your ${esc(sym.label || "symptom")}</div>`;
    if (sym.causes && sym.causes.length) html += `<p><b>Common causes:</b> ${sym.causes.map(esc).join("; ")}.</p>`;
    if (sym.watch && sym.watch.length) { html += `<div class="htag">⚠ Get urgent help if</div><ul>` + sym.watch.map(w => `<li>${esc(w)}</li>`).join("") + `</ul>`; }
    if (sym.care && sym.care.length) { html += `<div class="htag">What can help now</div><ul>` + sym.care.map(c => `<li>${esc(c)}</li>`).join("") + `</ul>`; }
    html += `<div class="ref"><span class="src">General guidance, not a diagnosis — tell me more (when it started, how bad, anything else) and I'll narrow it down.</span></div></div>`;
    return html;
  }

  // ---- Chapter library: deep educational chapters (pharmacy, therapies, etc.) ----
  const CHAP_SYN = {
    ch_pharmacy: ["pharmacy", "pharmacist", "pharmacology", "medication info", "how drugs work", "dosing", "drug class"],
    ch_physiotherapy: ["physiotherapy", "physio", "physical therapy", "physical therapist", "rehab exercise"],
    ch_massage: ["massage", "massage therapy", "soft tissue", "deep tissue"],
    ch_chiropractic: ["chiropractic", "chiropractor", "spinal manipulation", "adjustment"],
    ch_psychiatry: ["psychiatry", "psychiatrist", "psychotherapy", "psychologist", "therapy for depression", "counselling", "counseling", "mental health care"],
    ch_acupuncture: ["acupuncture", "traditional chinese medicine", "tcm", "needling", "cupping"],
    ch_holistic: ["holistic", "integrative medicine", "complementary medicine", "alternative medicine", "supplements"],
    ch_experimental: ["experimental", "emerging therapies", "clinical trial", "gene therapy", "immunotherapy", "psychedelic", "stem cell"],
    ch_anatomy: ["anatomy", "body layers", "skeleton", "muscles", "organs", "where is the"],
    ch_selfcheck: ["self check", "self exam", "self examination", "check myself", "feel for lumps", "home monitoring", "check my pulse"],
    ch_allied_map: ["who to see", "which specialist", "care team", "what kind of doctor", "referral", "who should i see"]
  };
  const CHAP_INTENT = /\b(chapter|learn about|teach me|explain|tell me about|what is|what does|overview of|guide to|book on)\b/;
  function chapterBlock() {
    if (!E.lastText || !E.book || !Array.isArray(E.book.chapters)) return "";
    const t = " " + E.lastText + " ";
    // find the best-matching chapter by synonym hit
    let hit = null, hitLen = 0;
    for (const ch of E.book.chapters) {
      const syns = (CHAP_SYN[ch.id] || []).concat([norm(ch.title), norm(ch.title.split(/[(&:,\u2014]/)[0])]);
      for (const s of syns) {
        const k = norm(s).trim();
        if (k && k.length >= 4 && t.indexOf(" " + k) >= 0 && k.length > hitLen) { hit = ch; hitLen = k.length; }
      }
    }
    if (!hit) return "";
    // only surface a full chapter when the person seems to want to learn (intent) OR named it specifically
    if (!CHAP_INTENT.test(E.lastText) && hitLen < 6) return "";
    // if the query names a specific section, expand it. Score by DISTINCTIVE word overlap:
    // ignore the chapter's own topic words and generic filler so a bare topic query
    // ("pharmacy") lists sections rather than drilling into a random one.
    const STOP = new Set(("therapy therapies medicine medical chapter learn teach explain tell about what does overview guide book the and for how work works your" +
      " " + (CHAP_SYN[hit.id] || []).join(" ") + " " + norm(hit.title)).split(/\s+/).filter(Boolean));
    const qTokens = new Set(norm(E.lastText).split(/\s+/).filter(w => w.length >= 5 && !STOP.has(w)));
    let sec = null, best = 0;
    for (const s of hit.sections) {
      const hw = new Set(norm(s.heading).split(/\s+/).filter(w => w.length >= 5 && !STOP.has(w)));
      let n = 0; for (const w of hw) if (qTokens.has(w)) n++;
      if (n > best) { best = n; sec = s; }
    }
    let html = `<div class="blk"><div class="htag">📖 ${esc(hit.title)} — chapter</div>`;
    html += `<div class="act">${esc(hit.overview)}</div>`;
    // Visual reference: show any original diagrams tagged to this chapter.
    const figs = (E.figures || []).filter(f => f.ref === hit.id);
    for (const f of figs) {
      html += `<div class="cand routine"><div class="cname">🖼 ${esc(f.title)}</div><div style="margin:6px 0">${f.svg}</div><div class="act" style="font-size:13px">${esc(f.caption)}</div></div>`;
    }
    // Teach / quiz mode: "quiz me on X", "teach me X", "test me" -> study set (recall then reveal).
    if (/\b(quiz|test me|study|flash ?cards?|teach me)\b/i.test(E.lastText) && typeof TEACH !== "undefined") {
      const set = TEACH.generateStudySet(hit);
      if (set) {
        html += `<div class="act"><b>🎓 Learning objectives</b><ul class="lookfor">` + set.objectives.map(o => `<li>${esc(o)}</li>`).join("") + `</ul></div>`;
        html += `<div class="act" style="margin-top:4px"><b>Self-check — recall each before you read on:</b></div>`;
        html += set.quiz.map(q => `<div class="cand routine"><div class="cname">${q.n}. ${esc(q.q)}</div><div class="act">${esc(q.answer)}</div></div>`).join("");
        html += `<div class="ref"><span class="src">${esc(set.note)}</span></div></div>`;
        return html;
      }
    }
    if (sec) {
      html += `<div class="cand routine"><div class="cname">${esc(sec.heading)}</div><div class="act">${esc(sec.body)}</div></div>`;
      html += `<div class="ref">Ask about another part: ${hit.sections.filter(x => x.id !== sec.id).slice(0, 6).map(x => esc(x.heading)).join(" · ")}</div>`;
    } else {
      html += `<div class="act"><b>In this chapter:</b><ul class="lookfor">` + hit.sections.map(s => `<li><b>${esc(s.heading)}</b></li>`).join("") + `</ul></div>`;
      html += `<div class="ref">Ask about any of these by name to read it in full.</div>`;
    }
    html += `<div class="ref"><span class="src">${esc(hit.source || "")}</span></div></div>`;
    return html;
  }

  // ---- Vocabulary: "define X" / "what does X mean" -> plain-language glossary ----
  function glossaryBlock() {
    if (!E.lastText || !E.book || !Array.isArray(E.book.glossary)) return "";
    if (!/\b(define|definition|meaning|mean|means|what is|whats|what s|explain the word|vocabulary)\b/.test(E.lastText)) return "";
    const t = " " + E.lastText + " ";
    const hits = E.book.glossary.filter(g => t.indexOf(" " + norm(g.term).trim() + " ") >= 0).slice(0, 4);
    if (!hits.length) return "";
    return `<div class="blk"><div class="htag">📖 Plain-language meaning</div>` + hits.map(g => `<div class="cand routine"><div class="cname">${esc(g.term)}</div><div class="act">${esc(g.def)}</div></div>`).join("") + `</div>`;
  }

  // ---- Medicine reference: official label excerpts + package pictures ----
  const DRUG_INTENT = /\b(what is|what are|whats|what s|tell me about|explain|used for|use of|uses|side effects?|dose|dosage|dosing|how (do|should) i take|how to take|look like|looks like|picture|photo|image|show me|pill|tablet|capsule|label|leaflet|warning|warnings|interact\w*|safe|pregnan\w*|overdose|info|information|about)\b/;
  function buildRefIndex() {
    E.drugIdx = []; E.condIdx = [];
    const add = (list, card, phrases) => { for (const ph of phrases || []) { const k = norm(String(ph)).trim(); if (k.length >= 4) list.push({ k, card }); } };
    if (E.drug && Array.isArray(E.drug.cards)) for (const c of E.drug.cards) add(E.drugIdx, c, (Array.isArray(c.phrases) ? c.phrases : []).concat([c.name || "", (c.id || "").replace(/^drug_/, "").replace(/_/g, " ")]));
    if (E.cond && Array.isArray(E.cond.cards)) for (const c of E.cond.cards) add(E.condIdx, c, (Array.isArray(c.phrases) ? c.phrases : []).concat([(c.id || "").replace(/^cond_/, "").replace(/_/g, " ")]));
    const byLen = (a, b) => b.k.length - a.k.length; E.drugIdx.sort(byLen); E.condIdx.sort(byLen);
  }
  function findCards(list, max) {
    const t = " " + E.lastText + " ", out = [];
    for (const e of list) { if (t.indexOf(" " + e.k + " ") >= 0 && out.indexOf(e.card) < 0) { out.push(e.card); if (out.length >= max) break; } }
    return out;
  }
  function drugBlock() {
    if (!E.lastText || !E.drugIdx || !E.drugIdx.length) return "";
    const cards = findCards(E.drugIdx, 2); if (!cards.length) return "";
    const bare = E.lastText.trim().split(/\s+/).length <= 3;
    if (!DRUG_INTENT.test(E.lastText) && !bare) return "";
    const pol = E.book && E.book.dosing_reference_policy;
    const SEC = [["uses", "What it is for"], ["boxed_warning", "⚠ Boxed warning (the label's most serious warning)"], ["dosing", "Label dosing — reference only"], ["do_not_use", "Do not use if"], ["warnings", "Warnings"], ["interactions", "Interactions"], ["side_effects", "Side effects"], ["pregnancy", "Pregnancy"], ["overdose", "Overdose"], ["forms", "Forms and strengths"]];
    let html = `<div class="blk meds"><div class="htag">💊 Medicine reference — from the official label</div>`;
    for (const c of cards) {
      const nm = c.name || (c.id || "").replace(/^drug_/, "").replace(/_/g, " ");
      html += `<div class="cand routine"><div class="cname">${esc(nm)}${c.type ? ` <span class="band possible">${esc(c.type)}</span>` : ""}</div>`;
      const meta = [c.generic && ("Generic: " + c.generic.toLowerCase()), c.brand && ("Label shown: " + c.brand), c.manufacturer, c.route && c.route.toLowerCase()].filter(Boolean);
      if (meta.length) html += `<div class="act" style="font-size:12.5px;opacity:.85">${esc(meta.join(" · "))}</div>`;
      if (c.images && c.images.length) {
        html += `<div class="pillrow">` + c.images.map(im => `<a href="${esc(im.file)}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(im.file)}" alt="Package or label image for ${esc(nm)}"></a>`).join("") + `</div>`;
        html += `<div class="ref" style="border:0;margin-top:2px">Package / label image from this one manufacturer's official US label. Your own medicine may look different — other makers, strengths and countries use different colours, shapes and markings. Never identify a loose pill from a picture alone; ask a pharmacist.</div>`;
      }
      if (c.label) {
        let first = true;
        for (const [k, lab] of SEC) {
          if (!c.label[k]) continue;
          const body = `<div class="act">${esc(c.label[k])}</div>` + (k === "dosing" ? `<div class="watch">Reference only — not a dosing guide. Follow your own prescriber or pharmacist and the label on your medicine.</div>` : "");
          if (first || k === "boxed_warning") html += `<div class="act" style="margin-top:6px"><b>${esc(lab)}</b></div>${body}`;
          else html += `<details class="lbl"><summary>${esc(lab)}</summary>${body}</details>`;
          first = false;
        }
      } else if (c.answer) html += `<div class="act">${esc(c.answer)}</div>`;
      html += `<div class="ref"><span class="src">${esc(c.source || "Official US label")}${c.label_date ? " · label dated " + esc(String(c.label_date).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")) : ""}${c.url ? ` · <a href="${esc(c.url)}" target="_blank" rel="noopener">full label</a>` : ""}</span></div></div>`;
    }
    html += `<div class="ref"><span class="src">${esc((pol && pol.statement) || "Label information is a reference to raise with your prescriber or pharmacist. It is not a real-world dosing guide.")}</span></div></div>`;
    return html;
  }
  // ---- Condition articles (reference layer of the Book) ----
  function condRefBlock() {
    if (!E.lastText || !E.condIdx || !E.condIdx.length) return "";
    if (!KNOW_INTENT.test(E.lastText) && !/\b(about|causes?|symptoms? of|signs of|treatment for|treat|cure|diagnos\w*|prevent\w*)\b/.test(E.lastText) && E.lastText.trim().split(/\s+/).length > 3) return "";
    const cards = findCards(E.condIdx, 1); if (!cards.length) return "";
    const c = cards[0]; const nm = (c.id || "").replace(/^cond_/, "").replace(/_/g, " ");
    const paras = String(c.answer || "").split(/(?<=[.!?])\s+(?=[A-Z])/); let out = [], cur = "";
    for (const sn of paras) { if ((cur + " " + sn).length > 420 && cur) { out.push(cur); cur = sn; } else cur = (cur + " " + sn).trim(); } if (cur) out.push(cur);
    let html = `<div class="blk web"><div class="htag">📚 Reference article — ${esc(nm)}</div>`;
    html += out.slice(0, 2).map(x => `<div class="act">${esc(x)}</div>`).join("");
    if (out.length > 2) html += `<details class="lbl"><summary>Read more</summary>${out.slice(2).map(x => `<div class="act">${esc(x)}</div>`).join("")}</details>`;
    const ph = (E.photos || []).filter(x => (x.cond || []).indexOf(c.id) >= 0).slice(0, 3);
    if (ph.length) html += photoRow(ph);
    html += `<div class="ref"><span class="src">${esc(c.source || "")}${c.url ? ` · <a href="${esc(c.url)}" target="_blank" rel="noopener">source</a>` : ""}</span></div></div>`;
    return html;
  }
  function photoRow(list) {
    return `<div class="photorow">` + list.map(x => `<figure><a href="${esc(x.file)}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(x.file)}" alt="${esc(x.label)}"></a><figcaption><b>${esc(x.label)}</b><br>${esc(x.credit)}</figcaption></figure>`).join("") + `</div><div class="ref" style="border:0">Photos are examples for learning. Conditions look different on different skin tones and bodies; a photo cannot diagnose you.</div>`;
  }
  function photoBlock() {
    if (!E.lastText || !E.photos || !E.photos.length) return "";
    if (!/\b(photo|photos|picture|pictures|pic|pics|image|images|look like|looks like|show me)\b/.test(E.lastText)) return "";
    const t = " " + E.lastText + " ";
    const hits = E.photos.filter(x => (x.keys || []).some(k => t.indexOf(" " + k + " ") >= 0)).slice(0, 4);
    if (!hits.length) return "";
    return `<div class="blk web"><div class="htag">📷 Photo reference</div>` + photoRow(hits) + `</div>`;
  }

  function compose() {
    const flags = redflagHits();
    const rows = score();
    const focus = focusSystems(rows);
    const groups = cluster(rows, focus.size ? focus : null);
    let html = "";
    const onco = oncoBlock();
    const nutri = nutritionBlock();
    const exam = examBlock();
    const vitals = vitalsBlock(E.lastVitals);
    const knowledge = knowledgeBlock();
    const chapter = chapterBlock();
    const gloss = glossaryBlock();
    let drugRef = drugBlock();
    const condRef = condRefBlock();
    const photoRef = photoBlock();
    let prof = profileBlock();
    let meds = medsBlock();
    const support = supportBlock();

    // Crisis or misuse: lead with the help, and show no medicine detail at all.
    const crisis = SELF_HARM_RX.test(E.lastText) || flags.some(f => f.id === "rf_suicide");
    const misuse = !crisis && MISUSE_RX.test(E.lastText);
    let flagsShown = false;
    const flagsHtml = () => { let h = `<div class="blk emerg"><div class="htag">⚠ Urgent safety check</div>`; for (const f of flags) { h += `<p>${esc(f.msg)}</p>`; h += refBlock(f.ref); } return h + `</div>`; };
    const poison = flags.some(f => /^rf_(overdose|poison_ingest|chemical_ingest)$/.test(f.id));
    if (crisis || misuse || poison) { prof = ""; meds = ""; drugRef = ""; }
    // Any emergency leads the reply: the action comes before profile, medicines or scores.
    if (flags.some(f => f.urgency === "emergency")) { html += flagsHtml(); flagsShown = true; }
    if (crisis) {
      html += `<div class="blk emerg"><div class="htag">Right now</div><p>If you have already taken something, call emergency services now, even if you feel fine.</p><p>Tell someone near you, or stay on the line with a crisis worker. If there are medicines or other means close by, ask someone to keep them for now.</p><p>I will not give amounts or methods. I can stay with you, help you plan the next hour, or help you find the words to tell someone.</p></div>`;
    }
    if (misuse) {
      html += `<div class="blk emerg"><div class="htag">Safer-use information — no amounts</div><p>I will not give an amount for getting high. No dose taken this way is predictably safe: tolerance varies from person to person and day to day, and pills bought outside a pharmacy are often counterfeit.</p><p><b>What lowers the risk:</b> never use alone; avoid mixing with alcohol, benzodiazepines or other sedatives, which is how most deaths happen; if opioids could be involved, keep naloxone within reach and make sure someone knows how to give it.</p><p><b>Call emergency services now</b> for slow, noisy or stopped breathing, blue or grey lips, gurgling, a seizure, chest pain, very high temperature, or someone who cannot be woken. Lay them on their side.</p><p><b>Free, confidential help:</b> Poison Control 1-800-222-1222 (US and Canada); SAMHSA helpline 1-800-662-4357 (US); 988 if you are in crisis. Drug-checking and peer information: DanceSafe and TripSit.</p><div class="ref">Ask “tell me about addiction medicine” or “overdose signs” for more.</div></div>`;
    }
    if (support) html += support;
    if (prof) html += prof;
    if (meds) html += meds;

    const grade = computeGrade(flags, groups); E.lastGrade = grade;
    // A request to look something up (a photo, a medicine label) is not a report of symptoms: no urgency score.
    const lookupOnly = (photoRef || drugRef) && !/\b(i have|i ve got|i got|i feel|i m|my |hurts?|pain|since|for (a|\d+) (day|week|month))\b/.test(E.lastText);
    if (grade.score && !lookupOnly) html += gradeBand(grade);

    if (flags.length && !flagsShown) html += flagsHtml();

    if (vitals) html += vitals;
    if (onco) html += onco;
    if (nutri) html += nutri;
    if (exam) html += exam;
    if (knowledge) html += knowledge;
    if (gloss) html += gloss;
    if (drugRef) html += drugRef;
    if (photoRef) html += photoRef;
    if (chapter) html += chapter;
    if (condRef) html += condRef;

    if (!rows.length && !flags.length && !onco && !nutri && !exam && !vitals && !knowledge && !chapter && !gloss && !meds && !support && !drugRef && !condRef && !photoRef && !misuse && !crisis) {
      if (E.present.size) {
        // A symptom was recognised but we can't narrow a cause yet — ask about THAT symptom
        // rather than a generic prompt, so vague complaints still get a useful next step.
        // prefer the present symptom that actually carries guidance (so e.g. nausea+rash
        // still surfaces real content), else the first present symptom.
        let sid = [...E.present].find(s => { const y = E.map.symptoms && E.map.symptoms[s]; return y && (y.causes || y.watch || y.care); }) || [...E.present][0];
        const sym = (E.map.symptoms && E.map.symptoms[sid]) || {};
        const lab = sym.label || "that";
        const ask = sym.ask || "";
        const guide = symptomGuideBlock(sid);
        if (guide) {
          // real, useful content + a short focusing question
          html += guide;
          const qv = [
            "To narrow it down: when did it start, and is anything else going on alongside it?",
            "How long has this been going on, and has it been getting better, worse, or staying the same?",
            "Tell me a bit more — when it began and anything that makes it better or worse — and I'll focus this.",
            "What else are you noticing with it, and when did it start?"
          ];
          let qm = vpick(qv, E.lastText + "|" + E.turns);
          if (qm === E.lastEmpty) qm = qv[(qv.indexOf(qm) + 1) % qv.length];
          E.lastEmpty = qm;
          html += wrapMsg(qm + (ask ? " " + ask : ""));
        } else {
          const variants = [
            "Thanks — I've noted the " + lab + ". Tell me more so I can narrow it down: when it started, how long it has lasted, where exactly, and anything that makes it better or worse.",
            "Okay — the " + lab + ". To work out what's behind it: when did it start, how bad is it, and does anything make it better or worse?",
            "Got it, the " + lab + ". A few more details will help me narrow it down — how long you've had it, where it is, and what it feels like.",
            "Noted — the " + lab + ". What else are you noticing, and has it changed since it began?"
          ];
          let m = vpick(variants, E.lastText + "|" + E.turns);
          if (m === E.lastEmpty) m = variants[(variants.indexOf(m) + 1) % variants.length];
          E.lastEmpty = m;
          html += wrapMsg(m + (ask ? " " + ask : ""));
        }
      } else {
        E.emptyStreak = (E.emptyStreak || 0) + 1;
        const arr = E.emptyStreak >= 2 ? ESCALATE : EMPTY;
        let m = vpick(arr, E.lastText + "|" + E.emptyStreak);
        if (m === E.lastEmpty) m = arr[(arr.indexOf(m) + 1) % arr.length];
        E.lastEmpty = m;
        html += wrapMsg(m);
      }
    } else { E.emptyStreak = 0; }

    if (groups.length) {
      html += `<div class="blk"><div class="htag">What this could be</div>`;
      // Offer a link into the 3D anatomy for the primary body system shown.
      const primarySys = (groups.find(g => g.inFocus) || groups[0] || {}).system;
      const layer3d = SYS_TO_3D[primarySys];
      if (layer3d) html += `<p style="margin:0 0 8px"><a href="body3d.html?focus=${layer3d}">View this area in 3D &#8599;</a></p>`;
      const foc = groups.filter(g => g.inFocus).map(g => syslabel(g.system));
      if (foc.length) html += `<p class="muted">${esc(vpick(LEAD, E.lastText))} this sounds like it's coming from your <b>${esc(foc.join(", "))}</b>. Here's what fits so far — tell me more and it'll re-focus.</p>`;
      else if (groups.length > 1) html += `<p class="muted">${esc(vpick(LEAD, E.lastText))} you've mentioned more than one thing, so I've grouped them.</p>`;
      for (const g of groups) {
        html += `<div class="sys">`;
        for (const r of g.rows) {
          const c = r.c;
          const bandLabel = { strong: "Most consistent", possible: "Possible", weak: "Less likely" }[r.band];
          const who = specialistFor(c);
          html += `<div class="cand ${c.urgency}">
            <div class="cname">${esc(c.name)} <span class="band ${r.band}">${bandLabel}</span></div>
            <div class="urg u-${c.urgency}">${esc(URG_LABEL[c.urgency])}</div>
            <div class="act">${esc(c.action)}</div>
            ${c.red ? `<div class="watch"><b>Watch for:</b> ${esc(c.red)}</div>` : ""}
            ${who ? `<div class="ref"><span class="src">Who to see: ${esc(who)}</span></div>` : ""}
            ${refBlock(c.ref)}
          </div>`;
        }
        html += `</div>`;
      }
      html += `</div>`;
    }

    html += carePlanBlock(rows);
    html += connected(rows);

    const q = nextQuestion(rows);
    if (q) html += `<div class="blk ask"><p>${esc(vpick(ASKLEAD, E.lastText + q))} ${esc(q)}</p></div>`;

    return html;
  }

  // Direct condition lookup: the user names a condition ("gout?", "could it be
  // shingles", "what is sepsis") rather than a symptom. Answer it with that
  // condition's card, then invite them to describe symptoms. Only fires when no
  // symptom extracted from this turn, so it never shadows symptom triage.
  function conditionQuery(text) {
    let t = norm(text).replace(/[?!.]+$/, "").trim();
    t = t.replace(/^(is it|is this|could it be|could this be|might it be|what is|whats|what s|do i have|have i got|i think its|i think it s|maybe|possibly|about|tell me about)\s+/, "").trim();
    if (!t) return null;
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length > 5) return null;
    let best = null, bestLen = 0;
    for (const c of E.map.conditions) {
      const cands = [norm(c.name), norm(c.id).replace(/_/g, " ")];
      for (const nl of cands) {
        const key = nl.replace(/\s*\(.*?\)\s*/g, " ").replace(/\b(consider|possible|suspected|acute|chronic|the|a|an)\b/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
        if (!key || key.length < 4) continue;
        // A single word only matches a condition whose WHOLE name is that word
        // (gout, migraine, shingles, sepsis) — never a body part like "head"
        // that merely appears inside a multi-word name ("head injury").
        const hit = (t === key) || (t === norm(c.id)) || (words.length === 1 && words[0].length >= 4 && key === words[0]);
        if (hit && key.length > bestLen) { best = c; bestLen = key.length; }
      }
    }
    if (!best) return null;
    const who = specialistFor(best);
    const card = `<div class="cand ${best.urgency}">
            <div class="cname">${esc(best.name)}</div>
            <div class="urg u-${best.urgency}">${esc(URG_LABEL[best.urgency])}</div>
            <div class="act">${esc(best.action)}</div>
            ${best.red ? `<div class="watch"><b>Watch for:</b> ${esc(best.red)}</div>` : ""}
            ${who ? `<div class="ref"><span class="src">Who to see: ${esc(who)}</span></div>` : ""}
            ${refBlock(best.ref)}
          </div>`;
    return `<div class="blk"><div class="htag">About ${esc(best.name)}</div>${card}</div>` +
      `<div class="blk ask"><p>If this might be you, tell me what you're feeling — where it is, when it started, and how bad — and I'll check how urgent it looks.</p></div>`;
  }

  // Natural-language 3D navigation: "show me my liver", "where are my kidneys".
  // Returns a link that opens that organ in the 3D anatomy. Fires only when the
  // turn carries no symptom (so it never shadows triage of "my liver hurts").
  const ORGAN_WORDS = {
    heart: "heart", lung: "lung_l", lungs: "lung_l", liver: "liver", kidney: "kidney_l",
    kidneys: "kidney_l", brain: "brain", stomach: "stomach", pancreas: "pancreas",
    spleen: "spleen", bladder: "bladder", intestine: "intestines", intestines: "intestines",
    bowel: "intestines", bowels: "intestines", gut: "intestines", guts: "intestines",
    thyroid: "thyroid", windpipe: "trachea", trachea: "trachea", airway: "trachea",
    prostate: "prostate", testes: "testes", testicle: "testes", testicles: "testes",
    womb: "uterus", uterus: "uterus"
  };
  function nav3d(text) {
    const t = norm(text);
    if (!/\b(show|see|view|where|find|look at|pull up|open|take me to|bring up|display)\b/.test(t)) return null;
    let found = null, word = null;
    for (const w in ORGAN_WORDS) { const re = new RegExp("\\b" + w + "\\b"); if (re.test(t)) { if (!found || w.length > word.length) { found = ORGAN_WORDS[w]; word = w; } } }
    if (!found) return null;
    const nice = word.charAt(0).toUpperCase() + word.slice(1);
    return `<div class="blk"><div class="htag">3D anatomy</div>` +
      `<p>Here's a 3D view of the ${esc(word)} you can rotate and zoom, with what it does and the tissue inside.</p>` +
      `<p style="margin:6px 0 0"><a href="body3d.html?organ=${found}">Open the ${esc(word)} in 3D &#8599;</a></p></div>` +
      `<div class="blk ask"><p>Want me to look at a symptom too? Tell me what's going on and I'll check it.</p></div>`;
  }

  // Public: process one user utterance, update state, return reply HTML.
  function turn(text) {
    E.turns++;
    E.lastText = aliasCanon(norm(text));
    const _st = smallTalk(text);
    if (_st) return _st;
    const _lc = " " + text.toLowerCase() + " ";
    const _v = parseVitals(_lc); E.lastVitals = _v.rows;
    setProfile(parseProfile(_lc));
    mergeProfileList("meds", medsToRecord(E.lastText));
    mergeProfileList("history", parseHistory(E.lastText));
    const { present, absent } = extract(text);
    // 3D navigation request (no symptom this turn): open the organ in 3D.
    if (present.size === 0) { const nv = nav3d(text); if (nv) return nv; }
    // Direct condition question (no symptom in this turn): answer it by name.
    if (present.size === 0) { const cq = conditionQuery(text); if (cq) return cq; }
    // Short-turn stitching: terse users type one or two words per turn ("chest", then
    // "tight", then "walking"). If a short turn matches nothing on its own, re-run
    // extraction over the last few fragments joined, and only ADD what that finds.
    E.recent = (E.recent || []); E.recent.push(norm(text)); if (E.recent.length > 4) E.recent.shift();
    if (present.size === 0 && norm(text).split(/\s+/).filter(Boolean).length <= 3 && E.recent.length > 1) {
      const stitched = E.recent.slice(-3).join(" ");
      const ex2 = extract(stitched);
      for (const s of ex2.present) present.add(s);
    }
    for (const s of present) { E.present.add(s); E.absent.delete(s); }
    for (const s of absent) { if (!E.present.has(s)) E.absent.add(s); }
    for (const s of _v.syms) { E.present.add(s); E.absent.delete(s); }
    let out = compose();
    const emergNow = /⚠ Urgent safety check|EMERGENCY —/.test(out);
    if (WORRY.test(E.lastText)) { out = wrapMsg(vpick(REASSURE, E.lastText)) + out; E.empathyShown = true; }
    else if (!E.empathyShown && emergNow) { out = wrapMsg(vpick(EMERG_EMPATHY, E.lastText)) + out; E.empathyShown = true; }
    else if (!E.empathyShown && CHILD.test(E.lastText) && (E.present.size || (E.lastVitals && E.lastVitals.length))) { out = wrapMsg(vpick(CHILD_EMPATHY, E.lastText)) + out; E.empathyShown = true; }
    return out;
  }

  function reset() { E.present = new Set(); E.absent = new Set(); E.asked = new Set(); E.turns = 0; E.profile = {}; E.lastAskSym = null; E.empathyShown = false; E.supportShown = new Set(); E.supportRemindN = 0; E.emptyStreak = 0; E.lastEmpty = null; E.recent = []; }

  // Deterministic one-shot (no stored state) — used by the test harness.
  function assess(text) {
    const saveP = E.present, saveA = E.absent, saveK = E.asked, saveT = E.lastText, saveV = E.lastVitals, saveProf = E.profile, saveES = E.emptyStreak, saveLE = E.lastEmpty, saveES2 = E.empathyShown, saveSS = E.supportShown, saveSRN = E.supportRemindN;
    E.present = new Set(); E.absent = new Set(); E.asked = new Set(); E.profile = Object.assign({}, saveProf); E.emptyStreak = 0; E.lastEmpty = null; E.empathyShown = false; E.supportShown = new Set(); E.supportRemindN = 0;
    E.lastText = aliasCanon(norm(text));
    const _lc = " " + text.toLowerCase() + " ";
    const _v = parseVitals(_lc); E.lastVitals = _v.rows;
    setProfile(parseProfile(_lc));
    mergeProfileList("meds", medsToRecord(E.lastText));
    mergeProfileList("history", parseHistory(E.lastText));
    const { present, absent } = extract(text);
    for (const s of _v.syms) present.add(s);
    E.present = present; E.absent = absent;
    const out = compose();
    E.present = saveP; E.absent = saveA; E.asked = saveK; E.lastText = saveT; E.lastVitals = saveV; E.profile = saveProf; E.emptyStreak = saveES; E.lastEmpty = saveLE; E.empathyShown = saveES2; E.supportShown = saveSS; E.supportRemindN = saveSRN;
    return out;
  }

  global.HIVETriage = { load, turn, reset, assess, extract, setProfile, summary, _state: E };
})(typeof window !== "undefined" ? window : globalThis);
