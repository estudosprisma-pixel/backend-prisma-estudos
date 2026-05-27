const today = new Date();
const toISODate = (date) => date.toISOString().slice(0, 10);
const addDaysISO = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + Number(days));
  return toISODate(date);
};
const daysAgo = (days) => addDaysISO(-days);
const editalCatalog = require("../catalog");
const defaultContestIds = editalCatalog.contests.map((contest) => contest.id);
const analystContest = editalCatalog.contests.find((contest) => contest.id === "analista-judiciario-area-administrativa");
const technicianContest = editalCatalog.contests.find((contest) => contest.id === "tecnico-judiciario-area-administrativa");

const seedState = {
  currentUserId: null,
  users: [
    { id: "u-admin", name: "Marina Admin", email: "admin@studyflow.local", password: "admin123", role: "admin", status: "active", accessExpiresAt: null },
    { id: "u-ana", name: "Ana Ribeiro", email: "ana@studyflow.local", password: "123456", role: "student", status: "active", accessExpiresAt: addDaysISO(30) },
    { id: "u-lucas", name: "Lucas Lima", email: "lucas@studyflow.local", password: "123456", role: "student", status: "active", accessExpiresAt: addDaysISO(7) }
  ],
  contests: [...editalCatalog.contests],
  profiles: {
    "u-ana": {
      studentName: "Ana Ribeiro",
      objective: "Aprovar em concurso de analista",
      context: "Concurso",
      dailyMinutes: 90,
      days: ["Seg", "Ter", "Qua", "Qui", "Sex", "Sab"],
      preferredTime: "19:00",
      interests: analystContest?.subjects || ["s-mat", "s-por", "s-dir"],
      contests: [...defaultContestIds],
      activeContestId: analystContest?.id || defaultContestIds[0],
      level: "intermediario",
      reviewPreference: "semanal",
      topicsPerDay: 2,
      mixSubjects: true
    },
    "u-lucas": {
      studentName: "Lucas Lima",
      objective: "Vestibular",
      context: "Prova",
      dailyMinutes: 60,
      days: ["Seg", "Qua", "Sex"],
      preferredTime: "07:00",
      interests: technicianContest?.subjects || ["s-mat", "s-his"],
      contests: [...defaultContestIds],
      activeContestId: technicianContest?.id || defaultContestIds[1] || defaultContestIds[0],
      level: "iniciante",
      reviewPreference: "a cada 2 dias",
      topicsPerDay: 1,
      mixSubjects: false
    }
  },
  subjects: [
    ...editalCatalog.subjects,
    { id: "s-mat", name: "Matematica", color: "#25d4c8", isBase: true, ownerId: null },
    { id: "s-por", name: "Portugues", color: "#f0a84a", isBase: true, ownerId: null },
    { id: "s-dir", name: "Direito Constitucional", color: "#69a7ff", isBase: true, ownerId: null },
    { id: "s-his", name: "Historia", color: "#45d483", isBase: true, ownerId: null },
    { id: "s-ana-red", name: "Redacao Estrategica", color: "#ff7a90", isBase: false, ownerId: "u-ana" }
  ],
  topics: [
    ...editalCatalog.topics,
    { id: "t-mat-1", subjectId: "s-mat", title: "Razao e proporcao", order: 1, suggestedMinutes: 45, isBase: true, ownerId: null },
    { id: "t-mat-2", subjectId: "s-mat", title: "Porcentagem aplicada", order: 2, suggestedMinutes: 50, isBase: true, ownerId: null },
    { id: "t-mat-3", subjectId: "s-mat", title: "Equacoes do primeiro grau", order: 3, suggestedMinutes: 55, isBase: true, ownerId: null },
    { id: "t-por-1", subjectId: "s-por", title: "Interpretacao de texto", order: 1, suggestedMinutes: 40, isBase: true, ownerId: null },
    { id: "t-por-2", subjectId: "s-por", title: "Classes de palavras", order: 2, suggestedMinutes: 45, isBase: true, ownerId: null },
    { id: "t-por-3", subjectId: "s-por", title: "Pontuacao", order: 3, suggestedMinutes: 35, isBase: true, ownerId: null },
    { id: "t-dir-1", subjectId: "s-dir", title: "Principios fundamentais", order: 1, suggestedMinutes: 50, isBase: true, ownerId: null },
    { id: "t-dir-2", subjectId: "s-dir", title: "Direitos e garantias fundamentais", order: 2, suggestedMinutes: 60, isBase: true, ownerId: null },
    { id: "t-his-1", subjectId: "s-his", title: "Brasil Colonia", order: 1, suggestedMinutes: 45, isBase: true, ownerId: null },
    { id: "t-red-1", subjectId: "s-ana-red", title: "Estrutura da dissertacao", order: 1, suggestedMinutes: 40, isBase: false, ownerId: "u-ana" }
  ],
  userSubjects: {
    "u-ana": [...(analystContest?.subjects || []), "s-ana-red"],
    "u-lucas": technicianContest?.subjects || ["s-mat", "s-his"]
  },
  userTopics: {
    "u-ana": {
      "t-mat-1": { status: "concluido", progress: 100, unlocked: true, completedAt: daysAgo(5) },
      "t-mat-2": { status: "em-andamento", progress: 35, unlocked: true, completedAt: null },
      "t-mat-3": { status: "pendente", progress: 0, unlocked: false, completedAt: null },
      "t-por-1": { status: "concluido", progress: 100, unlocked: true, completedAt: daysAgo(2) },
      "t-por-2": { status: "pendente", progress: 0, unlocked: true, completedAt: null },
      "t-por-3": { status: "pendente", progress: 0, unlocked: false, completedAt: null },
      "t-dir-1": { status: "pendente", progress: 0, unlocked: true, completedAt: null },
      "t-dir-2": { status: "pendente", progress: 0, unlocked: false, completedAt: null },
      "t-red-1": { status: "pendente", progress: 0, unlocked: true, completedAt: null }
    }
  },
  sessions: [
    { id: "ss-1", userId: "u-ana", subjectId: "s-mat", topicId: "t-mat-1", date: daysAgo(5), plannedMinutes: 45, studiedMinutes: 45, result: "concluido" },
    { id: "ss-2", userId: "u-ana", subjectId: "s-por", topicId: "t-por-1", date: daysAgo(2), plannedMinutes: 40, studiedMinutes: 42, result: "concluido" }
  ],
  reviews: [
    { id: "r-1", userId: "u-ana", subjectId: "s-mat", topicId: "t-mat-1", originalDate: daysAgo(5), dueDate: toISODate(today), count: 1, status: "pendente" }
  ],
  themes: {
    "u-ana": { mode: "dark", primary: "#25d4c8", secondary: "#f0a84a", cardStyle: "soft", banner: "assets/studyflow-banner.png", density: "normal" }
  },
  route: "dashboard"
};

module.exports = { seedState };
