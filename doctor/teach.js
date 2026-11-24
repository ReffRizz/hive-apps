// HIVE — TEACHING ENGINE (shared by Lawyer & Doctor). Deterministic, offline. Turns any
// chapter ({title, overview, sections:[{heading, body}]}) into a study set: learning
// objectives, recall flashcards (question -> answer), and self-check questions generated
// from the chapter's own content. No AI, no invented facts — it only reshapes the chapter
// the book already contains, so the same chapter always yields the same study set.
"use strict";
(function (root) {
  // First sentence (or first ~220 chars) of a body — the crux used for a flashcard answer.
  function gist(body) {
    const s = String(body || "").replace(/\s+/g, " ").trim();
    const m = s.match(/^(.{20,240}?[.!?])(\s|$)/);
    return (m ? m[1] : s.slice(0, 220)).trim();
  }
  // Pull SHOUTED or **key** terms a section defines (ALL-CAPS runs the authors used for
  // defined terms), for term-recall prompts. Deterministic, order-preserving, de-duplicated.
  function keyTerms(body) {
    const out = [], seen = new Set();
    const re = /\b([A-Z][A-Z’'/-]{2,}(?:\s+[A-Z][A-Z’'/-]{2,})*)\b/g;
    let m;
    while ((m = re.exec(String(body || ""))) !== null) {
      const t = m[1].replace(/\s+/g, " ").trim();
      if (t.length < 3 || t.length > 40) continue;
      if (/^(AND|THE|NOT|BUT|FOR|YOU|ALL|ANY|WHO|HOW|WHY|US|UK|CA|ID)$/.test(t)) continue;
      const k = t.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(t); }
    }
    return out.slice(0, 6);
  }
  function generateStudySet(chapter) {
    if (!chapter || !Array.isArray(chapter.sections)) return null;
    const objectives = chapter.sections.map(s => s.heading);
    const cards = chapter.sections.map(s => ({
      q: "Explain: " + s.heading,
      a: s.body,
      recall: gist(s.body),
      terms: keyTerms(s.body),
    }));
    // Self-check questions: one per section, phrased as a prompt from the heading.
    const quiz = chapter.sections.map((s, i) => ({
      n: i + 1,
      q: /\?$/.test(s.heading) ? s.heading : ("What should you understand about “" + s.heading.replace(/\s*\([^)]*\)\s*/g, " ").trim() + "”?"),
      answer: gist(s.body),
    }));
    return {
      title: chapter.title,
      intro: chapter.overview,
      count: chapter.sections.length,
      objectives, cards, quiz,
      note: "Study aid generated from this chapter — recall the answer before revealing it. It reshapes the book's own content; it does not add new facts.",
    };
  }
  const TEACH = { generateStudySet, gist, keyTerms };
  if (typeof module !== "undefined") module.exports = TEACH;
  else root.TEACH = TEACH;
})(typeof window !== "undefined" ? window : this);
