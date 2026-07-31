const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;

const config = connectionString
  ? { connectionString }
  : {
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE
    };

function validateDbConfig() {
  if (connectionString) return;
  const missing = Object.entries(config)
    .filter(([key, value]) => key !== "port" && !value)
    .map(([key]) => key);
  if (missing.length) {
    throw new Error(`Variaveis de banco ausentes: ${missing.join(", ")}. Configure DATABASE_URL ou PG* no Supabase.`);
  }
}

validateDbConfig();

const pool = new Pool({
  ...config,
  max: 10,
  ssl: { rejectUnauthorized: false }
});

module.exports = { pool, dbConfig: connectionString ? { connectionString: "DATABASE_URL" } : config };
