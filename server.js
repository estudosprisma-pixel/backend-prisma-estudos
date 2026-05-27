require("dotenv").config();

const path = require("path");
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

if (isProduction && jwtSecret === "dev-only-change-me") {
  throw new Error("JWT_SECRET precisa ser configurado em producao.");
}

app.use(cors({
  origin(origin, callback) {
    const allowed = process.env.CORS_ORIGIN?.split(",").map((item) => item.trim()).filter(Boolean);
    if (!origin || !allowed?.length || allowed.includes(origin)) return callback(null, true);
    return callback(new Error("Origem bloqueada pelo CORS."));
  }
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
  if (!email || !password) return res.status(400).json({ message: "Informe email e senha." });

  const [[user]] = await pool.query("SELECT * FROM users WHERE email = ? AND status = 'active' LIMIT 1", [email]);
  if (!user) return res.status(401).json({ message: "Login ou senha invalidos." });
  if (!isAccessActive(user)) return res.status(403).json({ message: "Seu acesso expirou. Fale com o administrador para renovar." });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ message: "Login ou senha invalidos." });

  const token = jwt.sign({ sub: user.id, role: user.role }, jwtSecret, { expiresIn: "8h" });
  const state = filterStateForUser(await readStateFromDb(), publicUser(user));
  state.currentUserId = user.id;
  state.route = user.role === "admin" ? "admin" : "dashboard";
  res.json({ token, user: publicUser(user), state });
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
  console.error(error);
  res.status(500).json({ message: "Erro interno no Prisma Estudos.", detail: isProduction ? undefined : error.message });
});

async function requireAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
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
