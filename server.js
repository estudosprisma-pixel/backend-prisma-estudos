require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const express = require("express");
const jwt = require("jsonwebtoken");
const { dbConfig, pool } = require("./db");
const { hasUsers, readStateFromDb, saveStateToDb } = require("./store");
const { seedState } = require("./seedData");

const app = express();
const port = Number(process.env.PORT || 3001);
const jwtSecret = process.env.JWT_SECRET || "dev-only-change-me";
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

if (isProduction && jwtSecret === "dev-only-change-me") {
  throw new Error("JWT_SECRET precisa ser configurado em producao.");
}

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
    database: dbConfig.database,
    environment: process.env.NODE_ENV || "development"
  });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const login = normalizeLoginIdentifier(email);
  if (!login || !password) return res.status(400).json({ message: "Informe usuario ou email e senha." });
  if (isRateLimited(req, login)) return res.status(429).json({ message: "Muitas tentativas. Aguarde alguns minutos e tente novamente." });

  const [[user]] = await pool.query("SELECT * FROM users WHERE email = ? LIMIT 1", [login]);
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

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    registerFailedLogin(req, login);
    return res.status(401).json({ message: "Login ou senha invalidos." });
  }

  const token = jwt.sign({ sub: user.id, role: user.role }, jwtSecret, { expiresIn: "8h" });
  clearFailedLogin(req, login);
  res.setHeader("Set-Cookie", buildAuthCookie(token));
  const state = filterStateForUser(await readStateFromDb(), publicUser(user));
  state.currentUserId = user.id;
  state.route = user.role === "admin" ? "admin" : "dashboard";
  res.json({ user: publicUser(user), state });
});

app.post("/api/auth/register", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const plan = normalizePlan(req.body?.plan);

  if (!name || !email || password.length < 6) {
    return res.status(400).json({ message: "Preencha nome, e-mail e uma senha com pelo menos 6 caracteres." });
  }

  const [[existingUser]] = await pool.query("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
  if (existingUser) {
    return res.status(409).json({ message: "Ja existe uma conta com este e-mail. Faça login para continuar." });
  }

  const userId = `u-${crypto.randomUUID()}`;
  const accessExpiresAt = addDaysToToday(PLAN_DURATIONS[plan]);
  const passwordHash = await bcrypt.hash(password, 10);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO users (id, name, email, password_hash, role, status, access_expires_at)
       VALUES (?, ?, ?, ?, 'student', 'active', ?)`,
      [userId, name, email, passwordHash, accessExpiresAt]
    );
    await connection.query(
      `INSERT INTO study_profiles
        (id, user_id, objective, education_context, daily_minutes, available_days, preferred_time, current_level, review_preference, topics_per_day, mix_subjects, profile_configured, onboarding_completed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `sp-${userId}`,
        userId,
        "",
        "",
        60,
        JSON.stringify(["Seg", "Ter", "Qua", "Qui", "Sex"]),
        "19:00",
        "iniciante",
        "semanal",
        2,
        1,
        0,
        0
      ]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  const [[user]] = await pool.query("SELECT * FROM users WHERE id = ? LIMIT 1", [userId]);
  const token = jwt.sign({ sub: user.id, role: user.role }, jwtSecret, { expiresIn: "8h" });
  res.setHeader("Set-Cookie", buildAuthCookie(token));
  const state = filterStateForUser(await readStateFromDb(), publicUser(user));
  state.currentUserId = user.id;
  state.route = "profile";
  res.status(201).json({ user: publicUser(user), state, plan });
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

    const paymentTokenColumns = await readPaymentTokenColumns();
    if (!paymentTokenColumns.has("transaction_id")) {
      console.error("Tabela payment_tokens sem coluna transaction_id");
      return res.status(200).json({
        ok: false,
        ignored: true,
        message: "Tabela payment_tokens sem coluna transaction_id."
      });
    }

    const [[existingToken]] = await pool.query(
      "SELECT token, customer_email, email, plan, transaction_id FROM payment_tokens WHERE transaction_id = ? LIMIT 1",
      [transactionId]
    );

    if (existingToken) {
      return res.status(200).json({ ok: true, duplicate: true, token: existingToken.token });
    }

    const token = generateSecureToken();
    const expiresAt = addDaysToDateTime(durationDays);
    console.log("criando token");

    const insertColumns = ["token", "plan", "transaction_id", "used", "created_at"];
    const insertValues = [token, plan, transactionId, 0, new Date()];

    if (paymentTokenColumns.has("duration_days")) {
      insertColumns.push("duration_days");
      insertValues.push(durationDays);
    }
    if (paymentTokenColumns.has("customer_email")) {
      insertColumns.push("customer_email");
      insertValues.push(email);
    }
    if (paymentTokenColumns.has("status")) {
      insertColumns.push("status");
      insertValues.push("active");
    }
    if (paymentTokenColumns.has("email")) {
      insertColumns.push("email");
      insertValues.push(email);
    }
    if (paymentTokenColumns.has("expires_at")) {
      insertColumns.push("expires_at");
      insertValues.push(expiresAt);
    }

    const placeholders = insertColumns.map(() => "?").join(", ");
    const [insertResult] = await pool.query(
      `INSERT IGNORE INTO payment_tokens (${insertColumns.join(", ")})
       VALUES (${placeholders})`,
      insertValues
    );

    if (!insertResult.affectedRows) {
      const [[duplicatedRow]] = await pool.query(
        "SELECT token FROM payment_tokens WHERE transaction_id = ? LIMIT 1",
        [transactionId]
      );
      return res.status(200).json({ ok: true, duplicate: true, token: duplicatedRow?.token || null });
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

  const [[row]] = await pool.query(
    `SELECT token, email, customer_email, plan, status, used, expires_at
     FROM payment_tokens
     WHERE token = ?
     LIMIT 1`,
    [token]
  );

  if (!row) {
    return res.json({ valid: false });
  }
  if (Boolean(row.used)) {
    return res.json({ valid: false });
  }
  if (row.status && row.status !== "active") {
    return res.json({ valid: false });
  }
  if (!isFutureDateTime(row.expires_at)) {
    return res.json({ valid: false });
  }

  return res.json({
    valid: true,
    email: row.customer_email || row.email,
    plan: row.plan
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
  const incoming = req.body?.state;
  if (!incoming || !Array.isArray(incoming.users)) return res.status(400).json({ message: "Estado invalido." });
  incoming.currentUserId = req.user.id;
  const stateToSave = req.user.role === "admin" ? incoming : mergeStudentState(await readStateFromDb(), incoming, req.user.id);
  await saveStateToDb(stateToSave);
  const state = filterStateForUser(await readStateFromDb(), req.user);
  state.currentUserId = req.user.id;
  state.route = incoming.route || (req.user.role === "admin" ? "admin" : "dashboard");
  res.json({ state });
});

app.post("/api/dev/seed", async (_req, res) => {
  if (process.env.NODE_ENV === "production") return res.status(403).json({ message: "Seed desativado em producao." });
  await saveStateToDb(seedState);
  res.json({ ok: true });
});

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ message: status === 403 ? error.message : "Erro interno no Prisma Estudos.", detail: isProduction ? undefined : error.message });
});

async function requireAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") || readCookie(req, authCookieName);
    if (!token) return res.status(401).json({ message: "Sessao expirada." });
    const payload = jwt.verify(token, jwtSecret);
    const [[user]] = await pool.query("SELECT id, name, email, role, status, access_expires_at FROM users WHERE id = ? AND status = 'active'", [payload.sub]);
    if (!user) return res.status(401).json({ message: "Usuario nao encontrado." });
    if (!isAccessActive(user)) return res.status(403).json({ message: "Acesso expirado." });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: "Sessao expirada." });
  }
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
  semestral: 180,
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

function addDaysToDateTime(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function isFutureDateTime(value) {
  if (!value) return false;
  const expiresAt = new Date(value);
  return expiresAt.getTime() >= Date.now();
}

function generateSecureToken() {
  return crypto.randomBytes(32).toString("hex");
}

function inferPlanDetails(productName, recurrence) {
  if (recurrence === 30) return { plan: "mensal", durationDays: 30 };
  if (recurrence === 180) return { plan: "semestral", durationDays: 180 };
  if (recurrence === 365) return { plan: "anual", durationDays: 365 };

  const text = String(productName || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (text.includes("anual")) return { plan: "anual", durationDays: 365 };
  if (text.includes("semestral")) return { plan: "semestral", durationDays: 180 };
  if (text.includes("mensal")) return { plan: "mensal", durationDays: 30 };
  return { plan: "mensal", durationDays: 30 };
}

function readPaymentTokenColumns() {
  return pool.query("SHOW COLUMNS FROM payment_tokens").then(([rows]) => new Set(rows.map((row) => row.Field)));
}

function isApprovedCaktoEvent(payload, item) {
  const eventName = String(payload?.event || "").trim().toLowerCase();
  const itemStatus = String(item?.status || "").trim().toLowerCase();
  const subscriptionStatus = String(item?.subscription?.status || "").trim().toLowerCase();
  return eventName === "purchase_approved" || itemStatus === "paid" || subscriptionStatus === "active";
}

function firstFilledValue(source, paths) {
  for (const pathName of paths) {
    const value = valueAtPath(source, pathName);
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

function valueAtPath(source, pathName) {
  return String(pathName || "")
    .split(".")
    .filter(Boolean)
    .reduce((current, key) => (current === undefined || current === null ? undefined : current[key]), source);
}

function buildAuthCookie(token) {
  return serializeCookie(authCookieName, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "None" : "Lax",
    path: "/",
    maxAge: 8 * 60 * 60
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

async function start() {
  if (process.env.AUTO_SEED === "true" && !(await hasUsers())) {
    console.log("AUTO_SEED ativo e tabela users vazia. Criando dados iniciais do Prisma Estudos...");
    await saveStateToDb(seedState);
  }
  await ensurePaymentTokenSchema();
  await ensureRequiredAdmins();
  app.listen(port, () => {
    console.log(`Prisma Estudos API rodando na porta ${port}`);
  });
}

async function ensureRequiredAdmins() {
  const admins = (seedState.users || []).filter((user) => user.role === "admin" && user.passwordHash);
  for (const admin of admins) {
    await pool.query(
      `INSERT INTO users (id, name, email, password_hash, role, status, access_expires_at)
       VALUES (?, ?, ?, ?, 'admin', 'active', NULL)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         password_hash = VALUES(password_hash),
         role = VALUES(role),
         status = VALUES(status),
         access_expires_at = VALUES(access_expires_at)`,
      [admin.id, admin.name, admin.email, admin.passwordHash]
    );
  }
}

async function ensurePaymentTokenSchema() {
  await pool.query(`
    ALTER TABLE payment_tokens
      ADD COLUMN IF NOT EXISTS customer_email VARCHAR(160) NULL AFTER email,
      ADD COLUMN IF NOT EXISTS duration_days INT NOT NULL DEFAULT 30 AFTER plan,
      ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active' AFTER transaction_id
  `);
}

if (require.main === module) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { app, start };
