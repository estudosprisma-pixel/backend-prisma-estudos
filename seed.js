require("dotenv").config();

const { pool } = require("./db");
const { seedState } = require("./seedData");
const { saveStateToDb } = require("./store");

saveStateToDb(seedState)
  .then(() => {
    console.log("Seed do Prisma Estudos concluido.");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
