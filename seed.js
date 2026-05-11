require("dotenv").config();

const { pool } = require("./db");
const { seedState } = require("./seedData");
const { saveStateToDb } = require("./store");

saveStateToDb(seedState)
  .then(() => {
    console.log("Seed do StudyFlow concluido.");
  })
  .finally(() => pool.end());
