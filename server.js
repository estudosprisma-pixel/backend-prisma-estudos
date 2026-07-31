require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const cors = require("cors");
const express = require("express");
const { dbConfig, pool } = require("./db");
const { supabaseAdmin, supabaseAuth } = require("./supabaseClient");
const { ensureSupabaseUser, remapUserIds, provisionSeedState } = require("./authProvisioning");
const { hasUsers, readStateFromDb, saveStateToDb } = require("./store");
const { seedState } = require("./seedData");

const app = express();
const port = Number(process.env.PORT || 3001);
const isProduction = process.env.NODE_ENV === "production";
const authCookieName = "prisma_estudos_session";
const defaultAllowedOrigins = [
  "https://frontend-prismaestudos.pages.dev",
  "https://prismaestudos.com.br",
  "https://www.prismaestudos.com.br",
  "http://localhost:4173",
  "http://localhost:5173",
  "http://127.0.0.1:4173",
  "http://127.0.0.1:5173"
];
const loginAttempts = new Map();
const loginAliases = {
  nat: "nat@prismaestudos.local",
  "joao.guilherme": "joao.guilherme@prismaestudos.local",
  joao: "joao.guilherme@prismaestudos.local",
  admin: "admin@prismaestudos.local"
};

app.disable("x-powered-by");
app.use((_, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});
app.use(cors({
  origin(origin, callback) {
    const configured = process.env.CORS_ORIGIN?.split(",").map((item) => item.trim()).filter(Boolean) || [];
    const allowed = new Set([...defaultAllowedOrigins, ...configured]);
    if (!origin || allowed.has(origin)) return callback(null, true);
    const error = new Error("Origem bloqueada pelo CORS.");
    error.status = 403;
    return callback(error);
  },
  credentials: true
}));
app.use(express.json({ limit: "3mb" }));
app.use("/assets", express.static(path.join(__dirname, "assets")));
app.use("/fotos editais", express.static(path.join(__dirname, "assets", "fotos editais")));

app.get("/api/health", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({
    ok: true,
    service: "Prisma Estudos API",
    database: dbConfig.database || "supabase",
    environment: process.env.NODE_ENV || "development"
  });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const login = normalizeLoginIdentifier(email);
  if (!login || !password) return res.status(400).json({ message: "Informe usuario ou email e senha." });
  if (isRateLimited(req, login)) return res.status(429).json({ message: "Muitas tentativas. Aguarde alguns minutos e tente novamente." });

  const { data: authData, error: authError } = await supabaseAuth.auth.signInWithPassword({ email: login, password });
  if (authError || !authData?.session) {
    registerFailedLogin(req, login);
    return res.status(401).json({ message: "Login ou senha invalidos." });
  }

  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1 LIMIT 1", [authData.user.id]);
  const user = rows[0];
  if (!user) {
    registerFailedLogin(req, login);
    return res.status(401).json({ message: "Login ou senha invalidos." });
  }
  if (user.status !== "active") {
    registerFailedLogin(req, login);
    return res.status(403).json({ message: "Sua conta esta inativa. Entre em contato com o suporte do Prisma Estudos." });
  }
  if (!isAccessActive(user)) {
    registerFailedLogin(req, login);
    return res.status(403).json({ message: "Seu acesso expirou. Renove sua assinatura para continuar usando o Prisma Estudos." });
  }

  clearFailedLogin(req, login);
  res.setHeader("Set-Cookie", buildAuthCookie(authData.session.access_token, authData.session.expires_in));
  const state = filterStateForUser(await readStateFromDb(), publicUser(user));
  state.currentUserId = user.id;
  state.route = user.role === "admin" ? "admin" : "dashboard";
  res.json({ user: publicUser(user), state });
});

app.post("/api/auth/register", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const paymentToken = String(req.body?.token || "").trim();

  if (!paymentToken) {
    return res.status(400).json({ message: "Cadastro disponivel apenas apos a confirmacao da compra." });
  }

  if (!name || password.length < 6) {
    return res.status(400).json({ message: "Preencha nome e uma senha com pelo menos 6 caracteres." });
  }

  const client = await pool.connect();
  let createdAuthUserId = null;
  try {
    await client.query("BEGIN");
    const tokenRow = await getPaymentTokenRecord(client, paymentToken, { lock: true });
    const tokenStatus = describePaymentTokenStatus(tokenRow);

    if (!tokenStatus.valid) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Link invalido, expirado ou ja utilizado." });
    }

    const plan = normalizePlan(tokenRow.plan);
    const durationDays = PLAN_DURATIONS[plan];
    const tokenEmail = String(tokenRow.customer_email || "").trim().toLowerCase();
    const finalEmail = tokenEmail || email;

    if (!finalEmail) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Nao foi possivel identificar o e-mail vinculado a compra." });
    }

    if (tokenEmail && email && tokenEmail !== email) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Use o e-mail vinculado a compra para concluir o cadastro." });
    }

    const { rows: existingRows } = await client.query("SELECT id FROM users WHERE email = $1 LIMIT 1", [finalEmail]);
    if (existingRows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Ja existe uma conta com este e-mail. Faca login para continuar." });
    }

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: finalEmail,
      password,
      email_confirm: true
    });
    if (authError || !authData?.user) {
      await client.query("ROLLBACK");
      throw new Error(authError?.message || "Falha ao criar usuario no Supabase Auth.");
    }
    createdAuthUserId = authData.user.id;
    const userId = authData.user.id;

    const accessExpiresAt = addDaysToToday(durationDays);
    await client.query(
      `INSERT INTO users (id, name, email, role, status, access_expires_at)
       VALUES ($1, $2, $3, 'student', 'active', $4)`,
      [userId, name, finalEmail, accessExpiresAt]
    );
    await client.query(
      `INSERT INTO study_profiles
        (id, user_id, objective, education_context, daily_minutes, available_days, preferred_time, current_level, review_preference, topics_per_day, mix_subjects, profile_configured, onboarding_completed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [`sp-${userId}`, userId, "", "", 60, JSON.stringify(["Seg", "Ter", "Qua", "Qui", "Sex"]), "19:00", "iniciante", "semanal", 2, true, false, false]
    );

    const tokenUpdate = await client.query(
      `UPDATE payment_tokens
       SET used = true,
           used_by_user_id = $1,
           used_at = now()
       WHERE token = $2
         AND used = false`,
      [userId, paymentToken]
    );

    if (tokenUpdate.rowCount !== 1) {
      throw new Error("Nao foi possivel marcar o token como utilizado.");
    }

    await client.query("COMMIT");

    const { rows: userRows } = await pool.query("SELECT * FROM users WHERE id = $1 LIMIT 1", [userId]);
    const user = userRows[0];
    const session = await createSessionForUser(finalEmail, password);
    res.setHeader("Set-Cookie", buildAuthCookie(session.access_token, session.expires_in));
    const state = filterStateForUser(await readStateFromDb(), publicUser(user));
    state.currentUserId = user.id;
    state.route = "profile";
    return res.status(201).json({ user: publicUser(user), state, plan });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (createdAuthUserId) await supabaseAdmin.auth.admin.deleteUser(createdAuthUserId).catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

app.post("/api/webhooks/cakto", async (req, res) => {
  console.log("Webhook recebido");
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const payload = req.body || {};
    const item = Array.isArray(payload.data) ? payload.data[0] : payload.data || payload;
    const receivedStatus = item?.status || item?.subscription?.status || payload.event || null;
    const approved = isApprovedCaktoEvent(payload, item);
    console.log("status recebido", receivedStatus || null);
    if (!approved) {
      console.log("Evento ignorado - não é pagamento aprovado");
      console.log("status inválido");
      return res.status(200).json({ ok: true, ignored: true, message: "Evento ignorado." });
    }

    console.log("item processado", item);

    const email = String(item?.customer?.email || item?.subscription?.customer?.email || "").trim().toLowerCase();
    const name = String(item?.customer?.name || item?.subscription?.customer?.name || "").trim();
    const transactionId = String(item?.id || item?.refId || item?.parent_order || "").trim();
    const productName = String(item?.product?.name || item?.offer?.name || "").trim();
    const recurrence = Number(item?.subscription?.recurrence_period || 0);
    const planDetails = inferPlanDetails(productName, recurrence);
    const { plan, durationDays } = planDetails;

    console.log("email extraído", email || null);
    console.log("transaction_id extraído", transactionId || null);
    console.log("plano identificado", plan || null);

    if (!email) {
      console.log("email ausente");
      return res.status(200).json({
        ok: true,
        ignored: true,
        message: "Payload aprovado sem email suficiente para gerar token."
      });
    }

    if (!transactionId) {
      console.log("transaction_id ausente");
      return res.status(200).json({
        ok: true,
        ignored: true,
        message: "Payload aprovado sem transaction_id suficiente para gerar token."
      });
    }

    const { rows: existingRows } = await pool.query(
      "SELECT token, customer_email, plan, transaction_id FROM payment_tokens WHERE transaction_id = $1 LIMIT 1",
      [transactionId]
    );
    const existingToken = existingRows[0];

    if (existingToken) {
      return res.status(200).json({ ok: true, duplicate: true, token: existingToken.token });
    }

    const token = generateSecureToken();
    console.log("criando token");

    const insertResult = await pool.query(
      `INSERT INTO payment_tokens
        (token, plan, duration_days, customer_email, transaction_id, status, used, created_at)
       VALUES ($1, $2, $3, $4, $5, 'active', false, now())
       ON CONFLICT (transaction_id) DO NOTHING`,
      [token, plan, durationDays, email, transactionId]
    );

    if (!insertResult.rowCount) {
      const { rows: duplicatedRows } = await pool.query(
        "SELECT token FROM payment_tokens WHERE transaction_id = $1 LIMIT 1",
        [transactionId]
      );
      return res.status(200).json({ ok: true, duplicate: true, token: duplicatedRows[0]?.token || null });
    }

    console.log("token criado", token);

    return res.status(200).json({ ok: true, token });
  } catch (error) {
    console.error("Erro ao criar token", error);
    return res.status(200).json({ ok: false, message: "Webhook recebido, mas nao foi processado." });
  }
});

app.get("/api/payment-tokens/validate", async (req, res) => {
  const token = String(req.query?.token || "").trim();
  if (!token) {
    return res.json({ valid: false });
  }

  const row = await getPaymentTokenRecord(pool, token);
  const tokenStatus = describePaymentTokenStatus(row);

  if (!tokenStatus.valid) {
    return res.json({ valid: false });
  }

  return res.json({
    valid: true,
    email: row.customer_email,
    plan: normalizePlan(row.plan)
  });
});

app.post("/api/auth/logout", (_req, res) => {
  res.setHeader("Set-Cookie", clearAuthCookie());
  res.json({ ok: true });
});

app.get("/api/state", requireAuth, async (req, res) => {
  const state = filterStateForUser(await readStateFromDb(), req.user);
  state.currentUserId = req.user.id;
  state.route = req.user.role === "admin" ? "admin" : "dashboard";
  res.json({ state });
});

app.put("/api/state", requireAuth, async (req, res) => {
  try {
    const incoming = req.body?.state;
    if (!incoming || !Array.isArray(incoming.users)) return res.status(400).json({ message: "Estado invalido." });
    incoming.currentUserId = req.user.id;
    if (req.user.role === "admin") {
      await provisionUsersForSupabaseAuth(incoming);
    }
    const stateToSave = req.user.role === "admin" ? incoming : mergeStudentState(await readStateFromDb(), incoming, req.user.id);
    await saveStateToDb(stateToSave);
    const state = filterStateForUser(await readStateFromDb(), req.user);
    state.currentUserId = req.user.id;
    state.route = incoming.route || (req.user.role === "admin" ? "admin" : "dashboard");
    res.json({ state });
  } catch (error) {
    console.error("Erro ao salvar estado do usuario", {
      userId: req.user?.id,
      code: error.code,
      message: error.message
    });
    res.status(500).json({ message: "Erro ao salvar estado." });
  }
});

app.post("/api/dev/seed", async (_req, res) => {
  if (process.env.NODE_ENV === "production") return res.status(403).json({ message: "Seed desativado em producao." });
  await provisionSeedState(seedState);
  await saveStateToDb(seedState);
  res.json({ ok: true });
});

// ── Study Reviews API ────────────────────────────────────────────────────────

app.get("/api/reviews/today", requireAuth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT * FROM study_reviews
     WHERE user_id = $1
       AND status = 'pendente'
       AND (next_review_date IS NULL OR next_review_date <= $2)
     ORDER BY next_review_date ASC, created_at ASC`,
    [req.user.id, today]
  );
  res.json({ reviews: rows.map(mapReviewRow) });
});

app.get("/api/reviews", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM study_reviews WHERE user_id = $1 ORDER BY created_at DESC",
    [req.user.id]
  );
  res.json({ reviews: rows.map(mapReviewRow) });
});

app.post("/api/reviews", requireAuth, async (req, res) => {
  const { title, subject, topic, difficulty, notes, next_review_date } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ message: "O campo titulo e obrigatorio." });
  }
  const id = `sr-${crypto.randomUUID()}`;
  const today = new Date().toISOString().slice(0, 10);
  const dayMap = { facil: 7, medio: 3, dificil: 1 };
  const nextDate = next_review_date || addDaysToToday(dayMap[difficulty] ?? 3);
  await pool.query(
    `INSERT INTO study_reviews
      (id, user_id, title, subject, topic, reviewed_at, next_review_date, status, difficulty, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pendente', $8, $9)`,
    [id, req.user.id, String(title).trim(), subject || null, topic || null,
     today, nextDate, difficulty || null, notes || null]
  );
  const { rows } = await pool.query("SELECT * FROM study_reviews WHERE id = $1", [id]);
  res.status(201).json({ review: mapReviewRow(rows[0]) });
});

app.patch("/api/reviews/:id", requireAuth, async (req, res) => {
  const { rows: existingRows } = await pool.query(
    "SELECT id, difficulty FROM study_reviews WHERE id = $1 AND user_id = $2",
    [req.params.id, req.user.id]
  );
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ message: "Revisao nao encontrada." });

  const { title, subject, topic, difficulty, notes, status, next_review_date } = req.body || {};
  const fields = [];
  const values = [];

  if (title !== undefined) { fields.push(`title = $${fields.length + 1}`); values.push(String(title).trim()); }
  if (subject !== undefined) { fields.push(`subject = $${fields.length + 1}`); values.push(subject || null); }
  if (topic !== undefined) { fields.push(`topic = $${fields.length + 1}`); values.push(topic || null); }
  if (difficulty !== undefined) { fields.push(`difficulty = $${fields.length + 1}`); values.push(difficulty || null); }
  if (notes !== undefined) { fields.push(`notes = $${fields.length + 1}`); values.push(notes || null); }
  if (status !== undefined) { fields.push(`status = $${fields.length + 1}`); values.push(status); }

  if (next_review_date !== undefined) {
    fields.push(`next_review_date = $${fields.length + 1}`);
    values.push(next_review_date || null);
  } else if (status === "concluida") {
    const dayMap = { facil: 7, medio: 3, dificil: 1 };
    const eff = difficulty || existing.difficulty;
    fields.push(`next_review_date = $${fields.length + 1}`);
    values.push(addDaysToToday(dayMap[eff] ?? 3));
  }

  if (status === "concluida") {
    fields.push("reviewed_at = " + `$${fields.length + 1}`);
    values.push(new Date().toISOString().slice(0, 10));
  }

  if (fields.length) {
    values.push(req.params.id, req.user.id);
    await pool.query(
      `UPDATE study_reviews SET ${fields.join(", ")}, updated_at = now() WHERE id = $${values.length - 1} AND user_id = $${values.length}`,
      values
    );
  }

  const { rows: updatedRows } = await pool.query("SELECT * FROM study_reviews WHERE id = $1", [req.params.id]);
  res.json({ review: mapReviewRow(updatedRows[0]) });
});

app.delete("/api/reviews/:id", requireAuth, async (req, res) => {
  const result = await pool.query(
    "DELETE FROM study_reviews WHERE id = $1 AND user_id = $2",
    [req.params.id, req.user.id]
  );
  if (!result.rowCount) return res.status(404).json({ message: "Revisao nao encontrada." });
  res.json({ ok: true });
});

function mapReviewRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    subject: row.subject || "",
    topic: row.topic || "",
    reviewedAt: dateOnly(row.reviewed_at),
    nextReviewDate: dateOnly(row.next_review_date),
    status: row.status,
    difficulty: row.difficulty || null,
    notes: row.notes || "",
    createdAt: dateOnly(row.created_at),
    updatedAt: dateOnly(row.updated_at)
  };
}

// ── User Preferences API ──────────────────────────────────────────────────────

const DEFAULT_PREFERENCES = {
  theme: "dark",
  accentColor: "blue",
  studyGoal: "",
  dailyStudyMinutes: 60,
  preferredSubjects: [],
  notificationsEnabled: true,
  soundEnabled: true,
  layoutMode: "default"
};

function mapPrefRow(row) {
  let subjects = [];
  try { subjects = typeof row.preferred_subjects === "string" ? JSON.parse(row.preferred_subjects) : (row.preferred_subjects || []); } catch {}
  return {
    theme: row.theme || "dark",
    accentColor: row.accent_color || "blue",
    studyGoal: row.study_goal || "",
    dailyStudyMinutes: Number(row.daily_study_minutes || 60),
    preferredSubjects: Array.isArray(subjects) ? subjects : [],
    notificationsEnabled: Boolean(row.notifications_enabled),
    soundEnabled: Boolean(row.sound_enabled),
    layoutMode: row.layout_mode || "default"
  };
}

app.get("/api/preferences", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM user_preferences WHERE user_id = $1 LIMIT 1", [req.user.id]);
  if (!rows[0]) return res.json({ preferences: { ...DEFAULT_PREFERENCES } });
  res.json({ preferences: mapPrefRow(rows[0]) });
});

app.put("/api/preferences", requireAuth, async (req, res) => {
  const { theme, accentColor, studyGoal, dailyStudyMinutes, preferredSubjects, notificationsEnabled, soundEnabled, layoutMode } = req.body || {};
  const id = `up-${req.user.id}`;
  const subjects = Array.isArray(preferredSubjects) ? JSON.stringify(preferredSubjects) : "[]";
  await pool.query(
    `INSERT INTO user_preferences (id, user_id, theme, accent_color, study_goal, daily_study_minutes, preferred_subjects, notifications_enabled, sound_enabled, layout_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (user_id) DO UPDATE SET
       theme = EXCLUDED.theme,
       accent_color = EXCLUDED.accent_color,
       study_goal = EXCLUDED.study_goal,
       daily_study_minutes = EXCLUDED.daily_study_minutes,
       preferred_subjects = EXCLUDED.preferred_subjects,
       notifications_enabled = EXCLUDED.notifications_enabled,
       sound_enabled = EXCLUDED.sound_enabled,
       layout_mode = EXCLUDED.layout_mode,
       updated_at = now()`,
    [
      id, req.user.id,
      theme || "dark",
      accentColor || "blue",
      studyGoal || "",
      Number(dailyStudyMinutes || 60),
      subjects,
      notificationsEnabled !== false,
      soundEnabled !== false,
      layoutMode || "default"
    ]
  );
  const { rows } = await pool.query("SELECT * FROM user_preferences WHERE user_id = $1", [req.user.id]);
  res.json({ preferences: mapPrefRow(rows[0]) });
});

// ── Error handler ─────────────────────────────────────────────────────────────

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ message: status === 403 ? error.message : "Erro interno no Prisma Estudos.", detail: isProduction ? undefined : error.message });
});

async function requireAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") || readCookie(req, authCookieName);
    if (!token) return res.status(401).json({ message: "Sessao expirada." });
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ message: "Sessao expirada." });
    const { rows } = await pool.query("SELECT id, name, email, role, status, access_expires_at FROM users WHERE id = $1 AND status = 'active'", [data.user.id]);
    const user = rows[0];
    if (!user) return res.status(401).json({ message: "Usuario nao encontrado." });
    if (!isAccessActive(user)) return res.status(403).json({ message: "Acesso expirado." });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: "Sessao expirada." });
  }
}

// Cria/atualiza no Supabase Auth cada usuario do state que veio com uma senha em texto plano
// (fluxo de criar/editar usuario no painel admin), remapeando o id temporario gerado no
// frontend para o uuid real, e remove do Supabase Auth quem foi excluido no admin.
async function provisionUsersForSupabaseAuth(incoming) {
  const usersWithPassword = (incoming.users || []).filter((user) => user.password);
  const { rows: currentUsers } = await pool.query("SELECT id FROM users");
  const currentUserIds = new Set(currentUsers.map((row) => row.id));
  const idMap = new Map();

  for (const user of usersWithPassword) {
    if (currentUserIds.has(user.id)) {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, { password: user.password });
      if (error) throw new Error(`Falha ao atualizar senha do usuario ${user.email}: ${error.message}`);
    } else {
      const realId = await ensureSupabaseUser(user.email, user.password);
      idMap.set(user.id, realId);
      user.id = realId;
    }
  }

  (incoming.users || []).forEach((user) => {
    delete user.password;
    delete user.passwordHash;
  });

  remapUserIds(incoming, idMap);

  const incomingIds = new Set((incoming.users || []).map((user) => user.id));
  const removedIds = [...currentUserIds].filter((id) => !incomingIds.has(id));
  for (const id of removedIds) {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(id);
    if (error) console.error("Falha ao remover usuario do Supabase Auth", { id, message: error.message });
  }
}

async function createSessionForUser(email, password) {
  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
  if (error || !data?.session) throw new Error(error?.message || "Falha ao iniciar sessao apos cadastro.");
  return data.session;
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    accessExpiresAt: dateOnly(user.access_expires_at)
  };
}

function isAccessActive(user) {
  if (user.role === "admin") return true;
  const expiresAt = dateOnly(user.access_expires_at);
  if (!expiresAt) return true;
  return expiresAt >= new Date().toISOString().slice(0, 10);
}

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function normalizeLoginIdentifier(value) {
  const login = String(value || "").trim().toLowerCase();
  if (!login) return "";
  if (login.includes("@")) return login;
  return loginAliases[login] || `${login}@prismaestudos.local`;
}

const PLAN_DURATIONS = {
  mensal: 30,
  trimestral: 90,
  anual: 365
};

function normalizePlan(value) {
  const plan = String(value || "").trim().toLowerCase();
  return PLAN_DURATIONS[plan] ? plan : "mensal";
}

function addDaysToToday(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isPaymentTokenActive(createdAt, durationDays) {
  if (!createdAt || !durationDays) return false;
  const createdTime = new Date(createdAt).getTime();
  if (Number.isNaN(createdTime)) return false;
  const expiresAt = createdTime + Number(durationDays) * 24 * 60 * 60 * 1000;
  return expiresAt >= Date.now();
}

function generateSecureToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function getPaymentTokenRecord(executor, token, options = {}) {
  const lockClause = options.lock ? " FOR UPDATE" : "";
  const { rows } = await executor.query(
    `SELECT token, plan, duration_days, customer_email, transaction_id, status, used, used_by_user_id, used_at, created_at
     FROM payment_tokens
     WHERE token = $1
     LIMIT 1${lockClause}`,
    [token]
  );
  return rows[0] || null;
}

function describePaymentTokenStatus(row) {
  if (!row) return { valid: false, reason: "missing" };
  if (Boolean(row.used)) return { valid: false, reason: "used" };
  if (row.status && row.status !== "active") return { valid: false, reason: "inactive" };
  if (!isPaymentTokenActive(row.created_at, row.duration_days)) return { valid: false, reason: "expired" };
  return { valid: true, reason: "ok" };
}

function inferPlanDetails(productName, recurrence) {
  if (recurrence === 30) return { plan: "mensal", durationDays: 30 };
  if (recurrence === 90) return { plan: "trimestral", durationDays: 90 };
  if (recurrence === 365) return { plan: "anual", durationDays: 365 };

  const text = String(productName || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  if (text.includes("anual")) return { plan: "anual", durationDays: 365 };
  if (text.includes("trimestral")) return { plan: "trimestral", durationDays: 90 };
  if (text.includes("mensal")) return { plan: "mensal", durationDays: 30 };
  return { plan: "mensal", durationDays: 30 };
}

function isApprovedCaktoEvent(payload, item) {
  const eventName = String(payload?.event || "").trim().toLowerCase();
  const itemStatus = String(item?.status || "").trim().toLowerCase();
  const subscriptionStatus = String(item?.subscription?.status || "").trim().toLowerCase();
  return eventName === "purchase_approved" || itemStatus === "paid" || subscriptionStatus === "active";
}

function buildAuthCookie(token, maxAgeSeconds = 3600) {
  return serializeCookie(authCookieName, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "None" : "Lax",
    path: "/",
    maxAge: maxAgeSeconds
  });
}

function clearAuthCookie() {
  return serializeCookie(authCookieName, "", {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "None" : "Lax",
    path: "/",
    maxAge: 0
  });
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join("; ");
}

function readCookie(req, name) {
  const cookies = req.headers.cookie?.split(";").map((item) => item.trim()) || [];
  const prefix = `${name}=`;
  const cookie = cookies.find((item) => item.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : "";
}

function loginAttemptKey(req, login) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = String(Array.isArray(forwarded) ? forwarded[0] : forwarded || req.ip || "").split(",")[0].trim();
  return `${ip}:${login}`;
}

function isRateLimited(req, login) {
  const attempt = loginAttempts.get(loginAttemptKey(req, login));
  if (!attempt) return false;
  if (Date.now() > attempt.resetAt) {
    loginAttempts.delete(loginAttemptKey(req, login));
    return false;
  }
  return attempt.count >= 8;
}

function registerFailedLogin(req, login) {
  const key = loginAttemptKey(req, login);
  const current = loginAttempts.get(key);
  const resetAt = Date.now() + 10 * 60 * 1000;
  loginAttempts.set(key, {
    count: current && Date.now() < current.resetAt ? current.count + 1 : 1,
    resetAt
  });
}

function clearFailedLogin(req, login) {
  loginAttempts.delete(loginAttemptKey(req, login));
}

function filterStateForUser(state, user) {
  if (user.role === "admin") return state;
  const subjectIds = new Set(state.userSubjects[user.id] || []);
  const subjects = state.subjects.filter((subject) => subject.isBase || subject.ownerId === user.id || subjectIds.has(subject.id));
  subjects.forEach((subject) => subjectIds.add(subject.id));
  const topicIds = new Set();
  const topics = state.topics.filter((topic) => {
    const visible = subjectIds.has(topic.subjectId) && (topic.isBase || topic.ownerId === user.id || subjects.some((subject) => subject.id === topic.subjectId && subject.ownerId === user.id));
    if (visible) topicIds.add(topic.id);
    return visible;
  });

  return {
    ...state,
    users: state.users.filter((item) => item.id === user.id),
    profiles: pickKey(state.profiles, user.id),
    subjects,
    topics,
    userSubjects: pickKey(state.userSubjects, user.id),
    userTopics: pickKey(state.userTopics, user.id),
    sessions: state.sessions.filter((session) => session.userId === user.id),
    reviews: state.reviews.filter((review) => review.userId === user.id),
    themes: pickKey(state.themes, user.id)
  };
}

function mergeStudentState(current, incoming, userId) {
  const ownedSubjectIds = new Set((incoming.subjects || []).filter((subject) => subject.ownerId === userId).map((subject) => subject.id));
  const ownedTopicIds = new Set((incoming.topics || []).filter((topic) => topic.ownerId === userId || ownedSubjectIds.has(topic.subjectId)).map((topic) => topic.id));

  return {
    ...current,
    currentUserId: userId,
    route: incoming.route || current.route,
    profiles: { ...current.profiles, [userId]: incoming.profiles?.[userId] || current.profiles[userId] },
    subjects: [
      ...current.subjects.filter((subject) => subject.ownerId !== userId),
      ...(incoming.subjects || []).filter((subject) => subject.ownerId === userId)
    ],
    topics: [
      ...current.topics.filter((topic) => topic.ownerId !== userId && !ownedSubjectIds.has(topic.subjectId)),
      ...(incoming.topics || []).filter((topic) => topic.ownerId === userId || ownedSubjectIds.has(topic.subjectId))
    ],
    userSubjects: { ...current.userSubjects, [userId]: incoming.userSubjects?.[userId] || current.userSubjects[userId] || [] },
    userTopics: { ...current.userTopics, [userId]: incoming.userTopics?.[userId] || current.userTopics[userId] || {} },
    sessions: [
      ...current.sessions.filter((session) => session.userId !== userId),
      ...(incoming.sessions || []).filter((session) => session.userId === userId)
    ],
    reviews: [
      ...current.reviews.filter((review) => review.userId !== userId),
      ...(incoming.reviews || []).filter((review) => review.userId === userId)
    ],
    themes: { ...current.themes, [userId]: incoming.themes?.[userId] || current.themes[userId] },
    users: current.users
  };
}

function pickKey(source, key) {
  return source?.[key] ? { [key]: source[key] } : {};
}

async function ensureRequiredAdmins() {
  const admins = (seedState.users || []).filter((user) => user.role === "admin" && user.password);
  for (const admin of admins) {
    const authUserId = await ensureSupabaseUser(admin.email, admin.password);
    await pool.query(
      `INSERT INTO users (id, name, email, role, status, access_expires_at)
       VALUES ($1, $2, $3, 'admin', 'active', NULL)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         email = EXCLUDED.email,
         role = EXCLUDED.role,
         status = EXCLUDED.status,
         access_expires_at = EXCLUDED.access_expires_at`,
      [authUserId, admin.name, admin.email]
    );
  }
}

async function start() {
  if (process.env.AUTO_SEED === "true" && !(await hasUsers())) {
    console.log("AUTO_SEED ativo e tabela users vazia. Criando dados iniciais do Prisma Estudos...");
    await provisionSeedState(seedState);
    await saveStateToDb(seedState);
  }
  await ensureRequiredAdmins();
  app.listen(port, () => {
    console.log(`Prisma Estudos API rodando na porta ${port}`);
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { app, start };
