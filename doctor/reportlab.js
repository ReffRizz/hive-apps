// HIVE Doctor — REPORT LAB. Deterministic, offline, rule-based. Reads a medical letter,
// lab report, or discharge summary: breaks it into point form, translates common jargon into
// plain language, and highlights the values, follow-ups, and terms worth asking a clinician
// about. It READS and EXPLAINS — it never diagnoses, never doses, and always points back to a
// professional. OCR happens in the app; this engine only reasons over text.
"use strict";
(function (root) {
  const RL = s => new RegExp(s, "i");
  const _ABBR = /\b(Dr|Mr|Mrs|Ms|St|No|approx|vs|e\.g|i\.e|a\.m|p\.m|mg|ml|mcg|kg|cm|mm|hr|b\.i\.d|t\.i\.d|q\.d|p\.r\.n)\.$/i;
  function splitPoints(text) {
    let t = String(text || "").replace(/\r/g, "");
    t = t.replace(/\b([A-Z])\.\s/g, "$1§ ").replace(/\b(Dr|Mr|Mrs|Ms|St|No|approx|vs|mg|ml|mcg|kg|cm|mm|hr)\.\s/gi, "$1§ ").replace(/\b(e\.g|i\.e|a\.m|p\.m)\.\s/gi, "$1§ ");
    return t.split(/(?<=[.!?])\s+|\n{1,}/).map(s => s.replace(/§/g, ".").trim()).filter(s => s.length > 1);
  }

  const CLASSIFY = [
    { type: "Lab / test result", icon: "🧪", re: RL("\\b(\\d+\\.?\\d*\\s?(mg/dl|mmol/l|g/dl|mmHg|/ul|k/ul|iu/l|u/l|ng/ml|%|bpm)|result|level|count|positive|negative|reference range|\\bH\\b|\\bL\\b)\\b") },
    { type: "Diagnosis / finding", icon: "🩺", re: RL("\\b(diagnos|impression|consistent with|suggestive of|evidence of|no evidence of|findings?:|assessment)\\b") },
    { type: "Medication", icon: "💊", re: RL("\\b(mg|mcg|tablet|capsule|dose|daily|twice|bid|tid|prn|prescri|rx|start|stop|continue|increase|decrease|discontinue)\\b") },
    { type: "Follow-up / instruction", icon: "📅", re: RL("\\b(follow[- ]?up|return if|come back|recheck|referral|refer to|see your|appointment|in \\d+ (days|weeks|months)|monitor|repeat in)\\b") },
    { type: "Red-flag term — ask about this", icon: "⚠", re: RL("\\b(malignan|metasta|carcinom|tumou?r|\\bmass\\b|lesion|embolism|ischem|infarct|hemorrhage|haemorrhage|sepsis|aneurysm|critical result)\\b") },
    { type: "Vital sign", icon: "❤", re: RL("\\b(blood pressure|bp\\b|heart rate|pulse|temperature|respirat|o2 sat|oxygen satur|spo2|weight|bmi)\\b") },
    { type: "Procedure / imaging", icon: "🩻", re: RL("\\b(x-?ray|ct\\b|mri|ultrasound|scan|biopsy|endoscop|surgery|procedure|ecg|ekg|echocardiogram)\\b") },
  ];
  function classify(p) { for (const c of CLASSIFY) if (c.re.test(p)) return { type: c.type, icon: c.icon }; return { type: "Note", icon: "•" }; }

  // Plain-language jargon glossary (reading aid; not medical advice).
  const JARGON = {
    "bilateral": "on both sides", "unilateral": "on one side", "benign": "not cancer (harmless)",
    "malignant": "cancerous", "acute": "sudden / short-term", "chronic": "long-term / ongoing",
    "idiopathic": "of unknown cause", "febrile": "with a fever", "afebrile": "no fever",
    "hypertension": "high blood pressure", "hypotension": "low blood pressure",
    "tachycardia": "fast heart rate", "bradycardia": "slow heart rate", "edema": "swelling (fluid)",
    "oedema": "swelling (fluid)", "dyspnea": "shortness of breath", "dyspnoea": "shortness of breath",
    "erythema": "redness of the skin", "lesion": "an area of abnormal tissue", "nodule": "a small lump",
    "mass": "a lump (needs explaining — not always cancer)", "effusion": "fluid build-up",
    "anemia": "low red blood cells / iron", "anaemia": "low red blood cells / iron",
    "leukocytosis": "high white blood cell count", "hyperglycemia": "high blood sugar",
    "hypoglycemia": "low blood sugar", "renal": "kidney", "hepatic": "liver", "cardiac": "heart",
    "pulmonary": "lung", "cerebral": "brain", "gastric": "stomach", "osteo": "bone",
    "neoplasm": "a new growth (tumour — benign or malignant)", "metastasis": "cancer that has spread",
    "prognosis": "the likely course/outcome", "etiology": "the cause", "aetiology": "the cause",
    "asymptomatic": "no symptoms", "prophylaxis": "prevention", "contraindicated": "should not be used",
    "stat": "immediately", "npo": "nothing by mouth", "prn": "as needed", "bid": "twice a day",
    "tid": "three times a day", "qd": "once a day", "wnl": "within normal limits",
    "sob": "shortness of breath", "cp": "chest pain", "hx": "history", "dx": "diagnosis",
    "tx": "treatment", "rx": "prescription", "fx": "fracture", "ca": "cancer",
    "cbc": "complete blood count", "bmp": "basic metabolic panel", "lft": "liver function test",
    "egfr": "a kidney-function measure", "a1c": "average blood sugar over ~3 months",
    "ldl": "'bad' cholesterol", "hdl": "'good' cholesterol", "tsh": "a thyroid test",
  };

  const DETECTORS = [
    { id: "abnormal_value", sev: "high", label: "A result is marked abnormal / out of range",
      test: t => /\b(abnormal|out of range|\bH\b|\bL\b|elevated|high\b|low\b|critical|positive|borderline|flagged)\b/.test(t),
      note: "The report marks one or more results as high, low, or abnormal. Abnormal flags are common and often not serious — they depend on your history and the lab's reference range. Ask the clinician who ordered it what this value means FOR YOU and whether anything needs to be done." },
    { id: "follow_up", sev: "high", label: "There is a follow-up or 'return if' instruction",
      test: t => /\b(follow[- ]?up|return if|come back|recheck|repeat in|referral|refer to|see your (doctor|gp|specialist)|appointment|in \d+ (days|weeks|months))\b/i.test(t),
      note: "This report asks for a follow-up action or names warning signs to come back for. Put any appointment, repeat test, or referral in your calendar, and act on the 'return if…' symptoms if they happen." },
    { id: "med_change", sev: "med", label: "A medication is being started, stopped, or changed",
      test: t => /\b(start|stop|discontinue|increase|decrease|switch|new prescription|titrate|hold)\b/i.test(t) && /\b(mg|mcg|tablet|dose|medication|drug|rx|prescri)\b/i.test(t),
      note: "A medicine is being changed. Confirm the exact name, dose, and timing with your pharmacist, ask what the change is for, and whether to stop anything you already take. Never change a dose on your own." },
    { id: "red_flag", sev: "high", label: "A serious-sounding term appears",
      test: t => /\b(malignan|metasta|carcinom|tumou?r|\bmass\b|lesion|embolism|ischem|infarct|hemorrhage|haemorrhage|sepsis|aneurysm|fracture|biopsy (positive|showed))\b/i.test(t),
      note: "A term here can sound alarming, but on paper it is often part of ruling something out, describing a past event, or noting something benign. Do not panic from the word alone — ask the clinician to explain exactly what it means in your case and what the plan is." },
    { id: "jargon_present", sev: "low", label: "Medical jargon is present (translated below)",
      test: () => false, note: "" }, // handled via glossary hits
  ];

  function analyzeReport(text) {
    const clean = String(text || "").trim();
    const points = splitPoints(clean);
    const breakdown = points.map(p => { const c = classify(p); return { icon: c.icon, type: c.type, text: p }; });
    const flags = [];
    for (const d of DETECTORS) { try { if (d.test(clean)) flags.push({ id: d.id, sev: d.sev, label: d.label, note: d.note }); } catch (e) { } }
    // jargon hits
    const low = " " + clean.toLowerCase().replace(/[^a-z0-9 ]/g, " ") + " ";
    const glossary = [];
    for (const term of Object.keys(JARGON)) { if (low.indexOf(" " + term + " ") >= 0) glossary.push({ term, plain: JARGON[term] }); }
    if (glossary.length) flags.push({ id: "jargon_present", sev: "low", label: `Plain-language translations (${glossary.length})`, note: "Common terms in this report, in everyday words. This is a reading aid, not a diagnosis." });
    const SEV = { high: 0, med: 1, low: 2 };
    flags.sort((a, b) => SEV[a.sev] - SEV[b.sev]);
    return {
      ok: clean.length > 0,
      wordCount: clean ? clean.split(/\s+/).length : 0,
      counts: { points: breakdown.length, flags: flags.length, high: flags.filter(f => f.sev === "high").length, jargon: glossary.length },
      breakdown, flags, glossary,
      disclaimer: "HIVE Doctor reads and explains this document in plain language — it is NOT a diagnosis and NOT a substitute for the clinician who wrote it. Abnormal flags and serious-sounding words are common and depend on your full picture. Bring your questions to your doctor or pharmacist; in an emergency call your local emergency number.",
    };
  }

  const REPORTLAB = { analyzeReport, splitPoints, classify, JARGON };
  if (typeof module !== "undefined") module.exports = REPORTLAB;
  else root.REPORTLAB = REPORTLAB;
})(typeof window !== "undefined" ? window : this);
