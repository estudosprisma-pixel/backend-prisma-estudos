const bcrypt = require("bcryptjs");
const { pool } = require("./db");
const { bool, dateOnly, dateTimeFor, fromDbStatus, toDbStatus } = require("./stateMapper");

async function readStateFromDb() {
  const [users] = await pool.query("SELECT id, name, email, role, status, access_expires_at FROM users ORDER BY created_at, id");
  const [profiles] = await pool.query("SELECT * FROM study_profiles");
  const [subjects] = await pool.query("SELECT * FROM subjects ORDER BY created_at, id");
  const [topics] = await pool.query("SELECT * FROM topics ORDER BY topic_order, id");
  const [userSubjects] = await pool.query("SELECT user_id, subject_id FROM user_subjects ORDER BY selected_at, subject_id");
  const [userTopics] = await pool.query("SELECT * FROM user_topics");
  const [sessions] = await pool.query("SELECT * FROM study_sessions ORDER BY started_at, id");
  const [reviews] = await pool.query("SELECT * FROM reviews ORDER BY due_date, id");
  const [themes] = await pool.query("SELECT * FROM user_theme_settings");

  const state = {
    currentUserId: null,
    users: users.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      accessExpiresAt: dateOnly(user.access_expires_at)
    })),
    profiles: {},
    subjects: subjects.map((subject) => ({
      id: subject.id,
      name: subject.name,
      color: subject.color,
      isBase: Boolean(subject.is_base),
      ownerId: subject.owner_user_id
    })),
    topics: topics.map((topic) => ({
      id: topic.id,
      subjectId: topic.subject_id,
      title: topic.title,
      order: topic.topic_order,
      suggestedMinutes: topic.suggested_minutes,
      isBase: Boolean(topic.is_base),
      ownerId: topic.owner_user_id
    })),
    userSubjects: {},
    userTopics: {},
    sessions: sessions.map((session) => ({
      id: session.id,
      userId: session.user_id,
      subjectId: session.subject_id,
      topicId: session.topic_id,
      date: dateOnly(session.started_at),
      plannedMinutes: session.planned_minutes,
      studiedMinutes: session.studied_minutes,
      result: fromDbStatus(session.result)
    })),
    reviews: reviews.map((review) => ({
      id: review.id,
      userId: review.user_id,
      subjectId: review.subject_id,
      topicId: review.topic_id,
      originalDate: dateOnly(review.original_study_date),
      dueDate: dateOnly(review.due_date),
      count: review.review_count,
      status: review.status
    })),
    themes: {},
    route: "dashboard"
  };

  profiles.forEach((profile) => {
    state.profiles[profile.user_id] = {
      studentName: users.find((user) => user.id === profile.user_id)?.name || "",
      objective: profile.objective || "",
      context: profile.education_context || "",
      dailyMinutes: profile.daily_minutes,
      days: parseJson(profile.available_days, []),
      preferredTime: profile.preferred_time || "19:00",
      interests: [],
      level: profile.current_level,
      reviewPreference: profile.review_preference,
      topicsPerDay: profile.topics_per_day,
      mixSubjects: Boolean(profile.mix_subjects),
      configured: Boolean(profile.profile_configured),
      onboardingCompleted: Boolean(profile.onboarding_completed)
    };
  });

  userSubjects.forEach((row) => {
    state.userSubjects[row.user_id] ||= [];
    state.userSubjects[row.user_id].push(row.subject_id);
  });

  Object.entries(state.userSubjects).forEach(([userId, subjectIds]) => {
    state.profiles[userId] ||= {};
    state.profiles[userId].interests = subjectIds;
  });

  userTopics.forEach((row) => {
    state.userTopics[row.user_id] ||= {};
    state.userTopics[row.user_id][row.topic_id] = {
      status: fromDbStatus(row.status),
      progress: row.progress_percent,
      unlocked: Boolean(row.unlocked),
      completedAt: dateOnly(row.completed_at)
    };
  });

  themes.forEach((theme) => {
    state.themes[theme.user_id] = {
      mode: theme.theme_mode,
      primary: theme.primary_color,
      secondary: theme.secondary_color,
      cardStyle: theme.card_style,
      banner: theme.banner_url || "",
      density: theme.density
    };
  });

  return state;
}

async function saveStateToDb(state) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [existingUsers] = await connection.query("SELECT id, password_hash FROM users");
    const passwordHashes = new Map(existingUsers.map((user) => [user.id, user.password_hash]));
    await connection.query("DELETE FROM reviews");
    await connection.query("DELETE FROM study_sessions");
    await connection.query("DELETE FROM user_topics");
    await connection.query("DELETE FROM user_subjects");
    await connection.query("DELETE FROM user_theme_settings");
    await connection.query("DELETE FROM study_profiles");
    await connection.query("DELETE FROM topics");
    await connection.query("DELETE FROM subjects");
    await connection.query("DELETE FROM users");

    for (const user of state.users || []) {
      const passwordHash = user.password
        ? await bcrypt.hash(user.password, 10)
        : passwordHashes.get(user.id) || await bcrypt.hash("123456", 10);
      await connection.query(
        `INSERT INTO users (id, name, email, password_hash, role, status, access_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [user.id, user.name, user.email, passwordHash, user.role || "student", user.status || "active", user.accessExpiresAt || null]
      );
    }

    for (const subject of state.subjects || []) {
      await connection.query(
        `INSERT INTO subjects (id, name, color, is_base, owner_user_id, created_by_admin_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [subject.id, subject.name, subject.color || "#25d4c8", bool(subject.isBase), subject.ownerId || null, subject.isBase ? state.currentUserId || null : null]
      );
    }

    for (const topic of state.topics || []) {
      await connection.query(
        `INSERT INTO topics (id, subject_id, title, topic_order, suggested_minutes, is_base, owner_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [topic.id, topic.subjectId, topic.title, topic.order || 1, topic.suggestedMinutes || 45, bool(topic.isBase), topic.ownerId || null]
      );
    }

    for (const [userId, profile] of Object.entries(state.profiles || {})) {
      if (!(state.users || []).some((user) => user.id === userId)) continue;
      await connection.query(
        `INSERT INTO study_profiles
          (id, user_id, objective, education_context, daily_minutes, available_days, preferred_time, current_level, review_preference, topics_per_day, mix_subjects, profile_configured, onboarding_completed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `sp-${userId}`,
          userId,
          profile.objective || "",
          profile.context || "",
          Number(profile.dailyMinutes || 60),
          JSON.stringify(profile.days || []),
          profile.preferredTime || "19:00",
          profile.level || "iniciante",
          profile.reviewPreference || "semanal",
          Number(profile.topicsPerDay || 1),
          bool(profile.mixSubjects),
          bool(profile.configured),
          bool(profile.onboardingCompleted)
        ]
      );
    }

    for (const [userId, subjectIds] of Object.entries(state.userSubjects || {})) {
      for (const subjectId of subjectIds || []) {
        await connection.query("INSERT IGNORE INTO user_subjects (user_id, subject_id) VALUES (?, ?)", [userId, subjectId]);
      }
    }

    for (const [userId, topics] of Object.entries(state.userTopics || {})) {
      for (const [topicId, topicState] of Object.entries(topics || {})) {
        await connection.query(
          `INSERT INTO user_topics (user_id, topic_id, status, progress_percent, unlocked, completed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [userId, topicId, toDbStatus(topicState.status), Number(topicState.progress || 0), bool(topicState.unlocked), topicState.completedAt || null]
        );
      }
    }

    for (const session of state.sessions || []) {
      await connection.query(
        `INSERT INTO study_sessions
          (id, user_id, subject_id, topic_id, started_at, finished_at, planned_minutes, studied_minutes, result, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          session.id,
          session.userId,
          session.subjectId,
          session.topicId,
          dateTimeFor(session.date),
          dateTimeFor(session.date),
          Number(session.plannedMinutes || 0),
          Number(session.studiedMinutes || 0),
          toDbStatus(session.result),
          session.notes || null
        ]
      );
    }

    for (const review of state.reviews || []) {
      await connection.query(
        `INSERT INTO reviews
          (id, user_id, subject_id, topic_id, original_study_date, due_date, review_count, status, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          review.id,
          review.userId,
          review.subjectId,
          review.topicId,
          review.originalDate,
          review.dueDate,
          Number(review.count || 0),
          review.status || "pendente",
          review.status === "feita" || review.status === "encerrada" ? review.dueDate : null
        ]
      );
    }

    for (const [userId, theme] of Object.entries(state.themes || {})) {
      await connection.query(
        `INSERT INTO user_theme_settings
          (user_id, theme_mode, primary_color, secondary_color, card_style, banner_url, density)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          theme.mode || "dark",
          theme.primary || "#25d4c8",
          theme.secondary || "#f0a84a",
          theme.cardStyle || "soft",
          theme.banner || null,
          theme.density || "normal"
        ]
      );
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function hasUsers() {
  const [[row]] = await pool.query("SELECT COUNT(*) AS total FROM users");
  return row.total > 0;
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

module.exports = {
  hasUsers,
  readStateFromDb,
  saveStateToDb
};
