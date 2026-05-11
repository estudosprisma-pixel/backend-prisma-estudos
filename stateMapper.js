const STATUS_TO_DB = {
  "em-andamento": "em_andamento",
  "nao-concluido": "nao_concluido"
};

const STATUS_FROM_DB = {
  em_andamento: "em-andamento",
  nao_concluido: "nao-concluido"
};

function toDbStatus(status) {
  return STATUS_TO_DB[status] || status || "pendente";
}

function fromDbStatus(status) {
  return STATUS_FROM_DB[status] || status || "pendente";
}

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function dateTimeFor(date) {
  return `${date || new Date().toISOString().slice(0, 10)} 12:00:00`;
}

function bool(value) {
  return value ? 1 : 0;
}

module.exports = {
  bool,
  dateOnly,
  dateTimeFor,
  fromDbStatus,
  toDbStatus
};
