const mysql = require("mysql2/promise");

const config = {
  host: process.env.DB_HOST || process.env.MYSQLHOST,
  port: Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306),
  user: process.env.DB_USER || process.env.MYSQLUSER,
  password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD,
  database: process.env.DB_NAME || process.env.MYSQLDATABASE
};

function validateDbConfig() {
  const missing = Object.entries(config)
    .filter(([key, value]) => key !== "port" && !value)
    .map(([key]) => key);
  if (missing.length) {
    throw new Error(`Variaveis de banco ausentes: ${missing.join(", ")}. Configure DB_* ou MYSQL* no Railway.`);
  }
}

validateDbConfig();

const pool = mysql.createPool({
  ...config,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
  timezone: "Z"
});

module.exports = { pool, dbConfig: config };
