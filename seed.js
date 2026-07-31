require("dotenv").config();

const { pool } = require("./db");
const { seedState } = require("./seedData");
const { saveStateToDb } = require("./store");
const { provisionSeedState } = require("./authProvisioning");

async function run() {
  await provisionSeedState(seedState);
  await saveStateToDb(seedState);
  console.log("Seed do Prisma Estudos concluido.");
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
