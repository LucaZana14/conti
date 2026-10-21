/* Conti — livello dati.
   Tiene in memoria (e in cache sul dispositivo) i documenti dell'utente e li salva su Supabase,
   nella tabella `documenti` (una riga per documento: collezione + id + dati JSON).
   Espone la stessa forma usata dalla pagina: db.collection(nome).doc(id).set/delete/onSnapshot. */
(function () {
  'use strict';
  const TABLE = 'documenti';
  const COLLECTIONS = ['movimenti', 'ricorrenti', 'impostazioni'];

  function createStore(client, userId) {
    const cache = new Map();          // "collezione/id" -> dati
    const colListeners = new Map();   // collezione -> Set(fn)
    const docListeners = new Map();   // "collezione/id" -> Set(fn)
    const LS_KEY = 'conti-cache-' + userId;
    let loaded = false;

    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (saved && Array.isArray(saved.rows)) {
        saved.rows.forEach(r => cache.set(r.collezione + '/' + r.id, r.dati));
        loaded = true;
      }
    } catch (e) { /* cache non disponibile: si parte dal server */ }

    const split = key => { const i = key.indexOf('/'); return [key.slice(0, i), key.slice(i + 1)]; };
    function persist() {
      try {
        const rows = [...cache].map(([k, v]) => { const [collezione, id] = split(k); return { collezione, id, dati: v }; });
        localStorage.setItem(LS_KEY, JSON.stringify({ at: Date.now(), rows }));
      } catch (e) { /* spazio pieno o storage bloccato: va bene lo stesso */ }
    }
    function colSnap(col) {
      const docs = [];
      for (const [k, v] of cache) {
        if (k.startsWith(col + '/')) { const id = k.slice(col.length + 1); docs.push({ id, exists: true, data: () => v }); }
      }
      docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { docs, size: docs.length, empty: docs.length === 0 };
    }
    function docSnap(key) { const v = cache.get(key); return { id: split(key)[1], exists: v !== undefined, data: () => v }; }
    function notify(col, key) {
      (colListeners.get(col) || []).forEach(fn => fn(colSnap(col)));
      for (const [k, set] of docListeners) {
        if (key ? k === key : k.startsWith(col + '/')) set.forEach(fn => fn(docSnap(k)));
      }
    }
    function notifyAll() {
      const cols = new Set([...colListeners.keys(), ...[...docListeners.keys()].map(k => split(k)[0])]);
      cols.forEach(c => notify(c));
    }

    async function refresh() {
      const { data, error } = await client.from(TABLE).select('collezione,id,dati');
      if (error) throw error;
      cache.clear();
      (data || []).forEach(r => cache.set(r.collezione + '/' + r.id, r.dati));
      loaded = true;
      persist();
      notifyAll();
    }

    async function write(col, id, dati) {
      const key = col + '/' + id, prev = cache.get(key);
      cache.set(key, dati); notify(col, key);
      const { error } = await client.from(TABLE).upsert(
        { user_id: userId, collezione: col, id, dati, aggiornato: new Date().toISOString() },
        { onConflict: 'user_id,collezione,id' });
      if (error) { if (prev === undefined) cache.delete(key); else cache.set(key, prev); notify(col, key); throw error; }
      persist();
    }
    async function remove(col, id) {
      const key = col + '/' + id, prev = cache.get(key);
      cache.delete(key); notify(col, key);
      const { error } = await client.from(TABLE).delete().match({ user_id: userId, collezione: col, id });
      if (error) { if (prev !== undefined) cache.set(key, prev); notify(col, key); throw error; }
      persist();
    }

    const newId = () => {
      const raw = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
      return raw.replace(/-/g, '').slice(0, 20);
    };
    const clone = d => JSON.parse(JSON.stringify(d));

    function docRef(col, id) {
      const key = col + '/' + id;
      return {
        id, path: key,
        set: d => write(col, id, clone(d)),
        delete: () => remove(col, id),
        get: async () => docSnap(key),
        onSnapshot(fn) {
          if (!docListeners.has(key)) docListeners.set(key, new Set());
          docListeners.get(key).add(fn);
          if (loaded) setTimeout(() => fn(docSnap(key)));
          return () => docListeners.get(key).delete(fn);
        },
      };
    }
    function colRef(col) {
      const q = {
        path: col,
        limit: () => q,
        orderBy: () => q,
        doc: id => docRef(col, id || newId()),
        add: async d => { const r = docRef(col, newId()); await r.set(d); return r; },
        onSnapshot(fn) {
          if (!colListeners.has(col)) colListeners.set(col, new Set());
          colListeners.get(col).add(fn);
          if (loaded) setTimeout(() => fn(colSnap(col)));
          return () => colListeners.get(col).delete(fn);
        },
      };
      return q;
    }

    // Importa un backup (quello esportato dalla pagina): sostituisce i documenti con lo stesso id.
    async function importBackup(obj) {
      if (!obj || typeof obj !== 'object') throw new Error('File non valido');
      const rows = [];
      const now = new Date().toISOString();
      const add = (collezione, id, dati) => {
        if (!id || typeof dati !== 'object' || dati === null) return;
        const { id: _drop, ...rest } = dati;
        rows.push({ user_id: userId, collezione, id: String(id).slice(0, 200), dati: rest, aggiornato: now });
      };
      if (obj.piano) add('impostazioni', 'piano', obj.piano);
      if (obj.saldi) add('impostazioni', 'saldi', obj.saldi);
      if (obj.struttura) add('impostazioni', 'struttura', obj.struttura);
      if (Array.isArray(obj.obiettivi)) add('impostazioni', 'obiettivi', { lista: obj.obiettivi });
      (obj.speseAutomatiche || obj.speseFisse || obj.ricorrenti || []).forEach(r => add('ricorrenti', r.id, r));
      (obj.movimenti || []).forEach(m => add('movimenti', m.id, m));
      if (!rows.length) throw new Error('Il file non contiene dati di Conti');
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await client.from(TABLE).upsert(rows.slice(i, i + 500), { onConflict: 'user_id,collezione,id' });
        if (error) throw error;
      }
      await refresh();
      return rows.length;
    }

    function clearLocal() { try { localStorage.removeItem(LS_KEY); } catch (e) {} }

    return {
      collection: colRef,
      doc: p => { const [c, id] = split(p); return docRef(c, id); },
      refresh, importBackup, clearLocal,
      hasData: () => loaded,
      COLLECTIONS,
    };
  }

  window.ContiStore = { createStore };
})();