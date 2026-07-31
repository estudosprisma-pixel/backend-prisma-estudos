const { pool } = require("./db");
const { bool, dateOnly, dateTimeFor, fromDbStatus, toDbStatus } = require("./stateMapper");

async function readStateFromDb() {
  const { rows: users } = await pool.query("SELECT id, name, email, role, status, access_expires_at FROM users ORDER BY created_at, id");
  const { rows: profiles } = await pool.query("SELECT * FROM study_profiles");
  const { rows: subjects } = await pool.query("SELECT * FROM subjects ORDER BY created_at, id");
  const { rows: topics } = await pool.query("SELECT * FROM topics ORDER BY topic_order, id");
  const { rows: userSubjects } = await pool.query("SELECT user_id, subject_id FROM user_subjects ORDER BY selected_at, subject_id");
  const { rows: userTopics } = await pool.query("SELECT * FROM user_topics");
  const { rows: sessions } = await pool.query("SELECT * FROM study_sessions ORDER BY started_at, id");
  const { rows: reviews } = await pool.query("SELECT * FROM reviews ORDER BY due_date, id");
  const { rows: themes } = await pool.query("SELECT * FROM user_theme_settings");

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
      extraInterests: [],
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
    state.profiles[userId].extraInterests = subjectIds.filter((subjectId) =>
      state.subjects.some((subject) => subject.id === subjectId && subject.ownerId === userId && !subject.isBase)
    );
  });

  userTopics.forEach((row) => {
    state.userTopics[row.user_id] ||= {};
    state.userTopics[row.user_id][row.topic_id] = {
      status: fromDbStatus(row.status),
      progress: row.progress_percent,
      unlocked: Boolean(row.unlocked),
      theoryRead: Boolean(row.theory_read),
      summaryDone: Boolean(row.summary_done),
      exercisesDone: Boolean(row.exercises_done),
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

// Importante: quem cria/apaga usuarios no Supabase Auth e remapeia ids temporarios para uuids
// reais e o server.js (rota PUT /api/state), antes de chamar esta funcao. Aqui assumimos que
// todo item de state.users ja tem um id que existe em auth.users/public.users.
async function saveStateToDb(state) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const validUserIds = new Set((state.users || []).map((user) => user.id));
    const validSubjects = (state.subjects || []).filter((subject) => subject?.id);
    const validSubjectIds = new Set(validSubjects.map((subject) => subject.id));
    const validTopics = (state.topics || []).filter((topic) => {
      const valid = topic?.id && validSubjectIds.has(topic.subjectId);
      if (!valid) console.warn("Ignorando topico sem materia correspondente ao salvar estado", { topicId: topic?.id, subjectId: topic?.subjectId });
      return valid;
    });
    const validTopicIds = new Set(validTopics.map((topic) => topic.id));

    await client.query("DELETE FROM reviews");
    await client.query("DELETE FROM study_sessions");
    await client.query("DELETE FROM user_topics");
    await client.query("DELETE FROM user_subjects");
    await client.query("DELETE FROM user_theme_settings");
    await client.query("DELETE FROM study_profiles");
    await client.query("DELETE FROM topics");
    await client.query("DELETE FROM subjects");
    await client.query("DELETE FROM users");

    for (const user of state.users || []) {
      await client.query(
        `INSERT INTO users (id, name, email, role, status, access_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [user.id, user.name, user.email, user.role || "student", user.status || "active", user.accessExpiresAt || null]
      );
    }

    for (const subject of validSubjects) {
      await client.query(
        `INSERT INTO subjects (id, name, color, is_base, owner_user_id, created_by_admin_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          subject.id,
          subject.name,
          subject.color || "#22d3ee",
          bool(subject.isBase),
          subject.ownerId && validUserIds.has(subject.ownerId) ? subject.ownerId : null,
          subject.isBase && state.currentUserId && validUserIds.has(state.currentUserId) ? state.currentUserId : null
        ]
      );
    }

    for (const topic of validTopics) {
      await client.query(
        `INSERT INTO topics (id, subject_id, title, topic_order, suggested_minutes, is_base, owner_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          topic.id,
          topic.subjectId,
          topic.title,
          topic.order || 1,
          topic.suggestedMinutes || 45,
          bool(topic.isBase),
          topic.ownerId && validUserIds.has(topic.ownerId) ? topic.ownerId : null
        ]
      );
    }

    for (const [userId, profile] of Object.entries(state.profiles || {})) {
      if (!(state.users || []).some((user) => user.id === userId)) continue;
      await client.query(
        `INSERT INTO study_profiles
          (id, user_id, objective, education_context, daily_minutes, available_days, preferred_time, current_level, review_preference, topics_per_day, mix_subjects, profile_configured, onboarding_completed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
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
      if (!validUserIds.has(userId)) {
        console.warn("Ignorando materias de usuario inexistente ao salvar estado", { userId });
        continue;
      }
      for (const subjectId of subjectIds || []) {
        if (!validSubjectIds.has(subjectId)) {
          console.warn("Ignorando user_subject sem materia correspondente ao salvar estado", { userId, subjectId });
          continue;
        }
        await client.query(
          "INSERT INTO user_subjects (user_id, subject_id) VALUES ($1, $2) ON CONFLICT (user_id, subject_id) DO NOTHING",
          [userId, subjectId]
        );
      }
    }

    for (const [userId, topics] of Object.entries(state.userTopics || {})) {
      if (!validUserIds.has(userId)) {
        console.warn("Ignorando topicos de usuario inexistente ao salvar estado", { userId });
        continue;
      }
      for (const [topicId, topicState] of Object.entries(topics || {})) {
        if (!validTopicIds.has(topicId)) {
          console.warn("Ignorando user_topic sem topico correspondente ao salvar estado", { userId, topicId });
          continue;
        }
        await client.query(
          `INSERT INTO user_topics
            (user_id, topic_id, status, progress_percent, unlocked, theory_read, summary_done, exercises_done, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            userId,
            topicId,
            toDbStatus(topicState.status),
            Number(topicState.progress || 0),
            bool(topicState.unlocked),
            bool(topicState.theoryRead),
            bool(topicState.summaryDone),
            bool(topicState.exercisesDone),
            topicState.completedAt || null
          ]
        );
      }
    }

    for (const session of state.sessions || []) {
      if (!validUserIds.has(session.userId) || !validSubjectIds.has(session.subjectId) || !validTopicIds.has(session.topicId)) {
        console.warn("Ignorando sessao com referencia inexistente ao salvar estado", {
          sessionId: session.id,
          userId: session.userId,
          subjectId: session.subjectId,
          topicId: session.topicId
        });
        continue;
      }
      await client.query(
        `INSERT INTO study_sessions
          (id, user_id, subject_id, topic_id, started_at, finished_at, planned_minutes, studied_minutes, result, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
      if (!validUserIds.has(review.userId) || !validSubjectIds.has(review.subjectId) || !validTopicIds.has(review.topicId)) {
        console.warn("Ignorando revisao com referencia inexistente ao salvar estado", {
          reviewId: review.id,
          userId: review.userId,
          subjectId: review.subjectId,
          topicId: review.topicId
        });
        continue;
      }
      await client.query(
        `INSERT INTO reviews
          (id, user_id, subject_id, topic_id, original_study_date, due_date, review_count, status, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
      if (!validUserIds.has(userId)) continue;
      await client.query(
        `INSERT INTO user_theme_settings
          (user_id, theme_mode, primary_color, secondary_color, card_style, banner_url, density)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          userId,
          theme.mode || "dark",
          theme.primary || "#22d3ee",
          theme.secondary || "#8b5cf6",
          theme.cardStyle || "soft",
          theme.banner || null,
          theme.density || "normal"
        ]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function hasUsers() {
  const { rows } = await pool.query("SELECT COUNT(*) AS total FROM users");
  return Number(rows[0].total) > 0;
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
