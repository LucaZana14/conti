// Configurazione di Conti.
// Incolla qui i due valori che trovi in Supabase → Project Settings → API.
// La chiave "anon" (o "publishable") è fatta per stare in una pagina pubblica:
// i dati restano protetti dalle regole di accesso del database (schema.sql).
// NON incollare mai qui la chiave "service_role" o "secret".
window.CONTI_CONFIG = {
  supabaseUrl: 'https://ylcxngytmwhvcnjjvqju.supabase.co',      // es. https://abcdefghijklm.supabase.co
  supabaseAnonKey: 'sb_publishable_ZKLcyZZBNglW4QwbVXDpNA_wBDHRSbz',        // inizia con eyJ... oppure sb_publishable_...
};
