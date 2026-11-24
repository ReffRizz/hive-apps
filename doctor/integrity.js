/* HIVE Doctor — runtime integrity check (browser).
   By Jeff Robinson · JR TraceCode. © 2026.
   Verifies the knowledge base against integrity_manifest.json using SHA-256
   (content-addressed forged/stale rejection — HIVE AtomStore / ARK1 principle).
   Result is cached by Merkle root so it runs once per version. Best-effort: if the
   browser has no SubtleCrypto (e.g. file://), it reports "unverified" and the app
   still works — it never blocks the deterministic engine. */
(function () {
  "use strict";
  var KEY = "hive_doctor_integrity_ok_root";
  async function sha256hex(buf) {
    var h = await crypto.subtle.digest("SHA-256", buf);
    var a = new Uint8Array(h), s = "";
    for (var i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, "0");
    return s;
  }
  async function verify() {
    try {
      if (!(window.crypto && crypto.subtle)) return { ok: null, reason: "no-subtlecrypto" };
      var man = await (await fetch("integrity_manifest.json", { cache: "no-store" })).json();
      // cached pass for this exact root? skip the re-hash.
      try { if (localStorage.getItem(KEY) === man.root) return { ok: true, cached: true, root: man.root, total: man.counts.atoms }; } catch (e) {}
      var bad = [], checked = 0, names = Object.keys(man.atoms);
      for (var i = 0; i < names.length; i++) {
        var f = names[i];
        try { var buf = await (await fetch(f)).arrayBuffer(); var hx = await sha256hex(buf); checked++; if (hx !== man.atoms[f].sha256) bad.push(f); }
        catch (e) { bad.push(f + " (unreadable)"); }
      }
      // recompute Merkle root
      var root = await sha256hex(new TextEncoder().encode(names.slice().sort().map(function (k) { return k + ":" + man.atoms[k].sha256; }).join("\n")));
      var ok = bad.length === 0 && root === man.root;
      try { if (ok) localStorage.setItem(KEY, man.root); } catch (e) {}
      return { ok: ok, checked: checked, total: man.counts.atoms, root: man.root, bad: bad };
    } catch (e) { return { ok: null, reason: String(e && e.message || e) }; }
  }
  window.HIVEIntegrity = { verify: verify };
})();
