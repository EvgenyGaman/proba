// Proba - server (Cloudflare Worker "proba-legendas")
// 1) Subtitles: audio -> Groq Whisper large-v3, returns timed segments. Audio is not stored.
// 2) Video upload: the page uploads each part in 5 MB pieces straight into R2 (bucket bound as BUCKET).
// 3) Submit: the page saves the summary + editing recipe (stickers, music, subtitles) next to the video.
// 4) Assistant: list / open / delete reviews, only with the secret ADMIN_KEY.
// Secrets: GROQ_API_KEY, ADMIN_KEY. Optional: TG_BOT, TG_CHAT (Telegram notice about new reviews).

const ALLOWED_ORIGINS = ["https://evgenygaman.github.io"];
const MAX_STT = 15 * 1024 * 1024;
const MAX_PART = 10 * 1024 * 1024;
const MAX_FILE = 300 * 1024 * 1024;
const CODE_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SID_RE = /^[a-f0-9]{8,32}$/;
const NAME_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const KEY_RE = /^reviews\/[A-Za-z0-9_-]{1,40}\/[a-f0-9]{8,32}\/[A-Za-z0-9_.-]{1,80}$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!allowed) return json({ error: "forbidden" }, 403);

    try {
      // ---------- subtitles ----------
      if ((path === "/" || path === "/stt") && request.method === "POST") return await stt(request, env, json);

      // ---------- key points: the transcript -> short theses with polarity + aspect + exact quote ----------
      if (path === "/theses" && request.method === "POST") return await theses(request, env, json);

      // ---------- storage routes need the bucket ----------
      if (!env.BUCKET) return json({ error: "storage not configured" }, 503);

      if (path === "/up/start" && request.method === "POST") {
        const b = await request.json();
        if (!CODE_RE.test(b.code || "") || !SID_RE.test(b.sid || "") || !NAME_RE.test(b.name || "")) return json({ error: "bad request" }, 400);
        if (!/^(video|image|audio)\//.test(b.type || "") || !(b.size > 0) || b.size > MAX_FILE) return json({ error: "bad file" }, 400);
        const key = `reviews/${b.code}/${b.sid}/${b.name}`;
        const mp = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: b.type } });
        return json({ key, uploadId: mp.uploadId });
      }

      if (path === "/up/part" && request.method === "PUT") {
        const key = url.searchParams.get("key") || "", uploadId = url.searchParams.get("uploadId") || "";
        const n = parseInt(url.searchParams.get("n") || "0", 10);
        if (!KEY_RE.test(key) || !uploadId || !(n >= 1 && n <= 10000)) return json({ error: "bad request" }, 400);
        const body = await request.arrayBuffer();
        if (!body.byteLength || body.byteLength > MAX_PART) return json({ error: "bad part" }, 400);
        const part = await env.BUCKET.resumeMultipartUpload(key, uploadId).uploadPart(n, body);
        return json({ n: part.partNumber, etag: part.etag });
      }

      if (path === "/up/done" && request.method === "POST") {
        const b = await request.json();
        if (!KEY_RE.test(b.key || "") || !b.uploadId || !Array.isArray(b.parts) || !b.parts.length) return json({ error: "bad request" }, 400);
        const obj = await env.BUCKET.resumeMultipartUpload(b.key, b.uploadId)
          .complete(b.parts.map((p) => ({ partNumber: p.n, etag: p.etag })));
        return json({ ok: true, key: b.key, size: obj.size });
      }

      if (path === "/submit" && request.method === "POST") {
        const text = await request.text();
        if (text.length > 300000) return json({ error: "too large" }, 413);
        const b = JSON.parse(text);
        if (!CODE_RE.test(b.code || "") || !SID_RE.test(b.sid || "")) return json({ error: "bad request" }, 400);
        const files = (Array.isArray(b.files) ? b.files : []).filter((k) => KEY_RE.test(k) && k.startsWith(`reviews/${b.code}/${b.sid}/`));
        const ts = new Date().toISOString();
        const meta = (b.meta && typeof b.meta === "object") ? b.meta : null;
        const rec = { ts, code: b.code, sid: b.sid, lang: b.lang || "", summary: String(b.summary || ""), recipe: b.recipe || null, meta, files, admin: { status: "novo" } };
        await env.BUCKET.put(`subs/${ts.replace(/[:.]/g, "-")}_${b.code}_${b.sid}.json`, JSON.stringify(rec), { httpMetadata: { contentType: "application/json" } });
        if (env.TG_BOT && env.TG_CHAT) ctx.waitUntil(notify(env, rec));
        return json({ ok: true });
      }

      // ---------- funnel: anonymous step marks (link code + step only, no personal data) ----------
      if (path === "/ev" && request.method === "POST") {
        const t = await request.text();
        if (t.length > 2000) return json({ error: "too large" }, 413);
        const e = JSON.parse(t);
        const step = String(e.step || ""), mode = String(e.mode || "-");
        if (!CODE_RE.test(e.code || "") || !SID_RE.test(e.sid || "") || !/^[a-z]{2,12}$/.test(step) || !/^[a-z-]{1,8}$/.test(mode)) return json({ error: "bad request" }, 400);
        await env.BUCKET.put(`ev/${e.code}/${e.sid}/${mode}.${step}`, "1");
        return json({ ok: true });
      }

      // ---------- technical problems reported by phones (errors, stalls); no personal data ----------
      if (path === "/log" && request.method === "POST") {
        const t = await request.text();
        if (t.length > 2000) return json({ error: "too large" }, 413);
        const e = JSON.parse(t);
        if (!CODE_RE.test(e.code || "") || !SID_RE.test(e.sid || "")) return json({ error: "bad request" }, 400);
        await env.BUCKET.put(`logs/${e.code}/${e.sid}/${Date.now()}`, String(e.msg || "").slice(0, 800));
        return json({ ok: true });
      }

      // ---------- assistant ----------
      if (path.startsWith("/admin/")) {
        const k = request.headers.get("X-Admin-Key") || "";
        if (!env.ADMIN_KEY || env.ADMIN_KEY.length < 8 || !same(k, env.ADMIN_KEY)) return json({ error: "unauthorized" }, 401);

        if (path === "/admin/list" && request.method === "GET") {
          const listed = await env.BUCKET.list({ prefix: "subs/", limit: 1000 });
          const keys = listed.objects.map((o) => o.key).sort().reverse().slice(0, 200);
          const items = await Promise.all(keys.map(async (key) => {
            const o = await env.BUCKET.get(key);
            if (!o) return null;
            const r = await o.json();
            r.id = key;
            return r;
          }));
          return json({ items: items.filter(Boolean) });
        }

        if (path === "/admin/events" && request.method === "GET") {
          const out = []; let cursor;
          for (let i = 0; i < 20; i++) {
            const l = await env.BUCKET.list({ prefix: "ev/", limit: 1000, cursor });
            l.objects.forEach((o) => { const p = o.key.split("/"); const ms = (p[3] || "").split("."); out.push({ code: p[1], sid: p[2], mode: ms[0], step: ms[1], t: o.uploaded }); });
            if (!l.truncated) break; cursor = l.cursor;
          }
          return json({ events: out });
        }

        if (path === "/admin/logs" && request.method === "GET") {
          const l = await env.BUCKET.list({ prefix: "logs/", limit: 1000 });
          const objs = l.objects.sort((x, y) => (x.uploaded < y.uploaded ? 1 : -1)).slice(0, 60);
          const logs = await Promise.all(objs.map(async (o) => { const p = o.key.split("/"); const g = await env.BUCKET.get(o.key); return { code: p[1], sid: p[2], t: o.uploaded, msg: g ? await g.text() : "" }; }));
          return json({ logs });
        }

        if (path === "/admin/meta" && request.method === "POST") {
          const b = await request.json();
          if (!/^subs\/[A-Za-z0-9_-]+\.json$/.test(b.id || "")) return json({ error: "bad request" }, 400);
          const o = await env.BUCKET.get(b.id);
          if (!o) return json({ error: "not found" }, 404);
          const r = await o.json();
          const a = r.admin || {};
          ["status", "note", "reason", "final", "useful"].forEach((k) => { if (typeof b[k] === "string") a[k] = b[k].slice(0, 2000); });
          if (typeof b.paid === "boolean") a.paid = b.paid;
          if (b.checks && typeof b.checks === "object") a.checks = b.checks;
          if (b.faces && typeof b.faces === "object") { const fz = JSON.stringify(b.faces); if (fz.length > 400000) return json({ error: "faces too large" }, 413); a.faces = b.faces; }
          a.updated = new Date().toISOString();
          r.admin = a;
          await env.BUCKET.put(b.id, JSON.stringify(r), { httpMetadata: { contentType: "application/json" } });
          r.id = b.id;
          return json({ ok: true, item: r });
        }

        if (path === "/admin/file" && request.method === "GET") {
          const key = url.searchParams.get("key") || "";
          if (!KEY_RE.test(key)) return json({ error: "bad request" }, 400);
          const o = await env.BUCKET.get(key);
          if (!o) return json({ error: "not found" }, 404);
          const h = new Headers(cors);
          o.writeHttpMetadata(h);
          h.set("Content-Length", String(o.size));
          return new Response(o.body, { headers: h });
        }

        if (path === "/admin/delete" && request.method === "POST") {
          const b = await request.json();
          if (!/^subs\/[A-Za-z0-9_-]+\.json$/.test(b.id || "")) return json({ error: "bad request" }, 400);
          const o = await env.BUCKET.get(b.id);
          if (o) {
            const r = await o.json();
            if (CODE_RE.test(r.code || "") && SID_RE.test(r.sid || "")) {
              const prefix = `reviews/${r.code}/${r.sid}/`;
              const all = await env.BUCKET.list({ prefix, limit: 1000 });
              if (all.objects.length) await env.BUCKET.delete(all.objects.map((x) => x.key));
            }
            await env.BUCKET.delete(b.id);
          }
          return json({ ok: true });
        }
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: "server error" }, 500);
    }
  },
};

function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function notify(env, rec) {
  const first = rec.summary.split("\n").slice(0, 6).join("\n");
  await fetch(`https://api.telegram.org/bot${env.TG_BOT}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TG_CHAT, text: "Nova avaliação\n" + first + "\nArquivos: " + rec.files.length }),
  }).catch(() => {});
}

async function stt(request, env, json) {
  if (!env.GROQ_API_KEY) return json({ error: "server not configured" }, 500);
  let form;
  try { form = await request.formData(); } catch (e) { return json({ error: "bad request" }, 400); }
  const file = form.get("file");
  if (!file || typeof file === "string") return json({ error: "no audio" }, 400);
  if (file.size > MAX_STT) return json({ error: "audio too large" }, 413);
  const language = (form.get("language") || "").toString().slice(0, 5);
  const send = async (model) => {
    const fd = new FormData();
    fd.append("file", file, file.name || "audio.webm");
    fd.append("model", model);
    fd.append("response_format", "verbose_json");
    fd.append("temperature", "0");
    if (language) fd.append("language", language);
    return fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.GROQ_API_KEY },
      body: fd,
    });
  };
  let r = await send("whisper-large-v3");
  if (!r.ok) r = await send("whisper-large-v3-turbo");
  const data = await r.json().catch(() => null);
  if (!r.ok || !data) return json({ error: "transcription failed", status: r.status }, 502);
  return json({
    language: data.language || null,
    duration: data.duration || null,
    segments: (data.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text })),
  });
}

const ASPECTS = ["resultado", "atendimento", "pontualidade", "limpeza", "preco", "ambiente", "durabilidade", "outro"];
async function theses(request, env, json) {
  if (!env.GROQ_API_KEY) return json({ error: "server not configured" }, 500);
  const b = await request.json().catch(() => null);
  if (!b || typeof b.text !== "string" || !b.text.trim()) return json({ error: "bad request" }, 400);
  const text = b.text.slice(0, 12000), lang = b.lang === "ru" ? "ru" : "pt";
  const sys = "You analyse a customer's spoken video review of a service visit (beauty: nails, hair, brows, lashes, etc.). " +
    "Extract only what the customer actually said, never invent. Return strict JSON: " +
    '{"theses":[{"text":string,"polarity":"pos"|"neg"|"neu","aspect":' + JSON.stringify(ASPECTS.join("|")) + ',"quote":string}],' +
    '"aspects":{"<aspect>":"pos"|"neg"|"mix"},"voltaria":"sim"|"nao"|"talvez"|"na","summary":string}. ' +
    "Rules: at most 6 theses, the most important first; text = a short claim (max 90 characters) in the same language as the review, written as the customer's own statement; " +
    "quote = 2 to 10 consecutive words copied EXACTLY from the transcript that best express the thesis; " +
    "aspects only for aspects the customer talked about; voltaria = whether the customer said they would come back; summary = one neutral sentence in the review's language. " +
    "If the transcript has no real content, return empty theses.";
  const user = "Service: " + String(b.service || "").slice(0, 40) + "\nTranscript:\n" + text;
  const call = (model) => fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.GROQ_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ model, temperature: 0.2, response_format: { type: "json_object" }, messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
  });
  let r = await call("openai/gpt-oss-120b");
  if (!r.ok) r = await call("llama-3.3-70b-versatile");
  const data = await r.json().catch(() => null);
  if (!r.ok || !data) return json({ error: "analysis failed", status: r.status }, 502);
  let out = {};
  try { out = JSON.parse(data.choices[0].message.content); } catch (e) { return json({ error: "bad output" }, 502); }
  const th = (Array.isArray(out.theses) ? out.theses : []).slice(0, 6).map((t) => ({
    text: String(t.text || "").slice(0, 140), polarity: ["pos", "neg", "neu"].includes(t.polarity) ? t.polarity : "neu",
    aspect: ASPECTS.includes(t.aspect) ? t.aspect : "outro", quote: String(t.quote || "").slice(0, 160),
  })).filter((t) => t.text);
  const asp = {}; Object.keys(out.aspects || {}).forEach((k) => { const v = out.aspects[k]; if (ASPECTS.includes(k) && ["pos", "neg", "mix"].includes(v)) asp[k] = v; });
  return json({ theses: th, aspects: asp, voltaria: ["sim", "nao", "talvez", "na"].includes(out.voltaria) ? out.voltaria : "na", summary: String(out.summary || "").slice(0, 300), lang });
}
