// Saves the journal in this GitHub repository, through the GitHub API.
// Each collection is one JSON file (a list of documents, each with its "id").
// Reading needs no key. Saving needs a fine-grained GitHub token with
// "Contents: read and write" on this repository, kept in this browser only.
//
// It mimics the small part of a Firestore-style API the page uses:
//   db.collection(name).onSnapshot(cb, onError)
//   db.collection(name).doc(id?).set(body) / .delete()
//   assets.upload(blob) -> {id}

const GitHubStore = (() => {
  const REPO = { owner: "ondacreative", repo: "fishing-journal", branch: "main" };
  const FILES = { catches: "data/catches.json", trips: "data/trips.json", bites: "data/bites.json" };
  const TOKEN_KEY = "fj_github_token";
  const API = `https://api.github.com/repos/${REPO.owner}/${REPO.repo}`;

  const token = {
    get() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } },
    set(v) { try { localStorage.setItem(TOKEN_KEY, v); } catch {} },
    clear() { try { localStorage.removeItem(TOKEN_KEY); } catch {} },
  };

  function headers(extra = {}) {
    const h = { Accept: "application/vnd.github+json", ...extra };
    const t = token.get();
    if (t) h.Authorization = `Bearer ${t}`;
    return h;
  }

  // base64 <-> text, safe for any character
  const toB64 = bytes => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const textToB64 = text => toB64(new TextEncoder().encode(text));
  const b64ToText = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), c => c.charCodeAt(0)));

  class StoreError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

  async function getFile(path) {
    // Via the API: always current, and gives the sha a save needs.
    const r = await fetch(`${API}/contents/${path}?ref=${REPO.branch}&t=${Date.now()}`, { headers: headers(), cache: "no-store" });
    if (r.status === 404) return { sha: null, list: [] };
    if (!r.ok) {
      // No key and over GitHub's hourly limit: fall back to the published copy (can be a minute behind).
      const pub = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
      if (pub.ok) return { sha: null, list: await pub.json(), stale: true };
      throw new StoreError(r.status === 401 ? "bad_key" : "unavailable", `GitHub said ${r.status}`);
    }
    const body = await r.json();
    return { sha: body.sha, list: JSON.parse(b64ToText(body.content)) };
  }

  async function putFile(path, b64, sha, message) {
    const r = await fetch(`${API}/contents/${path}`, {
      method: "PUT", headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ message, content: b64, branch: REPO.branch, ...(sha ? { sha } : {}) }),
    });
    if (r.status === 409 || r.status === 422) throw new StoreError("conflict", "Changed elsewhere");
    if (r.status === 401 || r.status === 403 || r.status === 404) throw new StoreError("bad_key", `GitHub refused the save (${r.status})`);
    if (!r.ok) throw new StoreError("unavailable", `GitHub said ${r.status}`);
    return (await r.json()).content.sha;
  }

  // ---------- collections held in memory, mirrored to the files
  const state = {};        // name -> { list, sha, listeners: [], loaded }
  let queue = Promise.resolve();

  function emit(name) {
    const s = state[name];
    const snap = { docs: s.list.map(d => { const { id, ...rest } = d; return { id, data: () => rest }; }) };
    for (const [cb] of s.listeners) cb(snap);
  }

  async function load(name) {
    const s = state[name];
    try {
      const f = await getFile(FILES[name]);
      s.list = f.list; s.sha = f.sha; s.loaded = true;
      emit(name);
    } catch (e) {
      for (const [, err] of s.listeners) err && err(e);
    }
  }

  // Apply a change to the latest copy of a file and save it. Saves run one at a time.
  function mutate(name, change, message) {
    const run = async () => {
      const s = state[name];
      for (let attempt = 0; attempt < 3; attempt++) {
        let { list, sha } = s;
        if (attempt > 0 || !sha) ({ list, sha } = await getFile(FILES[name]));
        const next = change(list.map(d => ({ ...d })));
        try {
          s.sha = await putFile(FILES[name], textToB64(JSON.stringify(next, null, 1) + "\n"), sha, message);
          s.list = next;
          emit(name);
          return;
        } catch (e) {
          if (e.code !== "conflict" || attempt === 2) throw e;
        }
      }
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const db = {
    collection(name) {
      if (!FILES[name]) throw new Error(`Unknown collection ${name}`);
      state[name] = state[name] || { list: [], sha: null, listeners: [], loaded: false };
      return {
        onSnapshot(cb, onError) {
          const s = state[name];
          s.listeners.push([cb, onError]);
          if (s.loaded) emit(name); else if (s.listeners.length === 1) load(name);
          return () => { s.listeners = s.listeners.filter(l => l[0] !== cb); };
        },
        doc(id) {
          id = id || newId();
          return {
            id,
            set: body => mutate(name, list => {
              const i = list.findIndex(d => d.id === id);
              const doc = { id, ...body };
              if (i >= 0) list[i] = doc; else list.push(doc);
              return list;
            }, `${i18n(name, body)} ${body.species || body.date || ""} ${body.weight || body.time || ""}`.trim()),
            update: patch => mutate(name, list => list.map(d => d.id === id ? { ...d, ...patch } : d), `Conditions for ${label(name, 1)}`),
            delete: () => mutate(name, list => list.filter(d => d.id !== id), `Delete ${label(name, 1)}`),
          };
        },
        // Several field updates in one save: {id: patch}
        updateMany: patches => mutate(name, list => list.map(d => patches[d.id] ? { ...d, ...patches[d.id] } : d),
          `Conditions for ${Object.keys(patches).length} ${label(name, Object.keys(patches).length)}`),
      };
    },
  };
  const i18n = (name, body) => name === "catches" ? "Fish:" : name === "bites" ? (body.kind === "lost" ? "Lost fish:" : "Bite:") : "Session:";
  const label = (name, n) => name === "catches" ? "fish" : name === "bites" ? (n === 1 ? "bite" : "bites") : n === 1 ? "session" : "sessions";

  const assets = {
    async upload(blob) {
      const id = `${newId()}.jpg`;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await putFile(`photos/${id}`, toB64(bytes), null, "Photo");
      return { id };
    },
  };
  const photoUrl = id => `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}/${REPO.branch}/photos/${encodeURIComponent(id)}`;

  // Is the saved key good for saving here? true, false (bad key), or null (no key).
  async function checkKey() {
    if (!token.get()) return null;
    try {
      const r = await fetch(API, { headers: headers(), cache: "no-store" });
      if (!r.ok) return false;
      const body = await r.json();
      return !!(body.permissions && body.permissions.push);
    } catch { return null; }
  }

  return { db, assets, photoUrl, token, checkKey, REPO };
})();
