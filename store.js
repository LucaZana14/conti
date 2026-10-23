/* Conti — livello dati.
   Tiene in memoria (e in cache sul dispositivo) i documenti dell'utente e li salva su Supabase,
   nella tabella `documenti` (una riga per documento: collezione + id + dati JSON).
   Espone la stessa forma usata dalla pagina: db.collection(nome).doc(id).set/delete/onSnapshot. */
(function () {
  'use strict';
  const TABLE = 'documenti';
  const COLLECTIONS = ['movimenti', 'ricorrenti', 'impostazioni'];

  function createStore(client, userId, opts) {
    const onError = (opts && opts.onError) || function () {};
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

    // Le modifiche si vedono subito (cache locale) e vanno al server in sottofondo, in ordine, una alla volta per documento:
    // la pagina non aspetta la rete per chiudere un foglio. Se il server rifiuta, si torna all'ultimo valore salvato
    // e la pagina viene avvisata con onError.
    const chains = new Map();   // "collezione/id" -> promessa dell'ultima scrittura in coda
    const ver = new Map();      // "collezione/id" -> numero dell'ultima modifica locale
    const confirmed = new Map(); // "collezione/id" -> ultimo valore confermato dal server (undefined = non esiste)
    const pending = () => [...chains.values()];

    async function refresh() {
      if (chains.size) await Promise.allSettled(pending());
      const { data, error } = await client.from(TABLE).select('collezione,id,dati');
      if (error) throw error;
      if (chains.size) return; // nel frattempo è arrivata una modifica: la prossima sincronizzazione la ritroverà salvata
      cache.clear(); confirmed.clear();
      (data || []).forEach(r => { const k = r.collezione + '/' + r.id; cache.set(k, r.dati); confirmed.set(k, r.dati); });
      loaded = true;
      persist();
      notifyAll();
    }

    function queue(col, id, dati, job) {
      const key = col + '/' + id;
      if (!confirmed.has(key)) confirmed.set(key, cache.get(key));
      const v = (ver.get(key) || 0) + 1; ver.set(key, v);
      if (dati === undefined) cache.delete(key); else cache.set(key, dati);
      notify(col, key);
      const run = (chains.get(key) || Promise.resolve()).catch(() => {}).then(job);
      chains.set(key, run);
      run.then(() => { confirmed.set(key, dati); persist(); },
        err => {
          if (ver.get(key) === v) { const back = confirmed.get(key); if (back === undefined) cache.delete(key); else cache.set(key, back); notify(col, key); persist(); }
          onError(err);
        })
        .finally(() => { if (chains.get(key) === run) chains.delete(key); });
      run.catch(() => {});
      return Promise.resolve();
    }
    function write(col, id, dati) {
      return queue(col, id, dati, async () => {
        const { error } = await client.from(TABLE).upsert(
          { user_id: userId, collezione: col, id, dati, aggiornato: new Date().toISOString() },
          { onConflict: 'user_id,collezione,id' });
        if (error) throw error;
      });
    }
    function remove(col, id) {
      return queue(col, id, undefined, async () => {
        const { error } = await client.from(TABLE).delete().match({ user_id: userId, collezione: col, id });
        if (error) throw error;
      });
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
      saving: () => chains.size > 0,
      hasData: () => loaded,
      COLLECTIONS,
    };
  }

  window.ContiStore = { createStore };
})();