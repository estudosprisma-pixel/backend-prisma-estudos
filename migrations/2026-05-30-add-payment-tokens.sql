CREATE TABLE IF NOT EXISTS payment_tokens (
  token VARCHAR(80) PRIMARY KEY,
  email VARCHAR(160) NOT NULL,
  plan ENUM('mensal', 'semestral', 'anual') NOT NULL DEFAULT 'mensal',
  transaction_id VARCHAR(120) NOT NULL UNIQUE,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
