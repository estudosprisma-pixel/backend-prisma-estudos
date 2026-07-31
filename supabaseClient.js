const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const missing = Object.entries({ SUPABASE_URL: supabaseUrl, SUPABASE_ANON_KEY: supabaseAnonKey, SUPABASE_SERVICE_ROLE_KEY: supabaseServiceRoleKey })
  .filter(([, value]) => !value)
  .map(([key]) => key);
if (missing.length) {
  throw new Error(`Variaveis do Supabase ausentes: ${missing.join(", ")}.`);
}

const clientOptions = { auth: { autoRefreshToken: false, persistSession: false } };

// Client com a service role: usado para operacoes administrativas (criar/editar/apagar usuarios
// do Supabase Auth) que precisam contornar RLS e nao podem ser feitas com a anon key.
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, clientOptions);

// Client com a anon key: usado para login (signInWithPassword), que deve se comportar como um
// usuario comum se autenticando, nao como admin.
const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, clientOptions);

module.exports = { supabaseAdmin, supabaseAuth };
