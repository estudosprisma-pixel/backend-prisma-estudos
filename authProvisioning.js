const { supabaseAdmin } = require("./supabaseClient");

async function findSupabaseUserByEmail(email) {
  let page = 1;
  const perPage = 200;
  while (page <= 20) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(error.message);
    const found = data.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());
    if (found) return found;
    if (data.users.length < perPage) return null;
    page += 1;
  }
  return null;
}

// Garante que exista um usuario no Supabase Auth para este e-mail: cria se nao existir, ou
// atualiza a senha se ja existir (idempotente, usado no seed e no ensureRequiredAdmins). Retorna
// o uuid do usuario no Supabase Auth.
async function ensureSupabaseUser(email, password) {
  const { data, error } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (!error) return data.user.id;

  if (!/already.*registered|already.*exists/i.test(error.message || "")) {
    throw new Error(`Falha ao criar usuario ${email} no Supabase Auth: ${error.message}`);
  }
  const existing = await findSupabaseUserByEmail(email);
  if (!existing) throw new Error(`Usuario ${email} ja existe no Supabase Auth mas nao foi localizado via listUsers.`);
  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(existing.id, { password });
  if (updateError) throw new Error(`Falha ao atualizar senha de ${email}: ${updateError.message}`);
  return existing.id;
}

async function deleteSupabaseUser(id) {
  const { error } = await supabaseAdmin.auth.admin.deleteUser(id);
  if (error) console.error("Falha ao remover usuario do Supabase Auth", { id, message: error.message });
}

// Reescreve todas as referencias a um id de usuario "antigo" (id local/temporario) para o uuid
// real do Supabase Auth, em todas as fatias do state que guardam esse id.
function remapUserIds(state, idMap) {
  if (!idMap.size) return;
  const remap = (id) => idMap.get(id) || id;

  (state.subjects || []).forEach((subject) => {
    if (subject.ownerId) subject.ownerId = remap(subject.ownerId);
  });
  (state.topics || []).forEach((topic) => {
    if (topic.ownerId) topic.ownerId = remap(topic.ownerId);
  });
  (state.sessions || []).forEach((session) => {
    if (session.userId) session.userId = remap(session.userId);
  });
  (state.reviews || []).forEach((review) => {
    if (review.userId) review.userId = remap(review.userId);
  });

  ["profiles", "userSubjects", "userTopics", "themes"].forEach((key) => {
    const source = state[key];
    if (!source) return;
    for (const [oldId, newId] of idMap.entries()) {
      if (Object.prototype.hasOwnProperty.call(source, oldId)) {
        source[newId] = source[oldId];
        delete source[oldId];
      }
    }
  });
}

// Usado pelo seed (seed.js, AUTO_SEED e /api/dev/seed): provisiona no Supabase Auth todo
// usuario do state que ainda tem uma senha em texto plano (ids fixos de seed, tipo "u-ana"),
// remapeia esses ids para os uuids reais em todo o state, e remove os campos de senha.
// Idempotente: numa segunda chamada com o mesmo objeto (senhas ja removidas), nao faz nada.
async function provisionSeedState(state) {
  const idMap = new Map();
  for (const user of state.users || []) {
    if (!user.password) continue;
    const realId = await ensureSupabaseUser(user.email, user.password);
    if (realId !== user.id) idMap.set(user.id, realId);
    user.id = realId;
    delete user.password;
    delete user.passwordHash;
  }
  remapUserIds(state, idMap);
  return state;
}

module.exports = { ensureSupabaseUser, findSupabaseUserByEmail, deleteSupabaseUser, remapUserIds, provisionSeedState };
