-- Migration: Criar tabela study_reviews
-- Execute este SQL no banco MySQL do Railway antes de fazer deploy do backend atualizado.

CREATE TABLE IF NOT EXISTS study_reviews (
  id            VARCHAR(40)  PRIMARY KEY,
  user_id       VARCHAR(40)  NOT NULL,
  title         VARCHAR(255) NOT NULL,
  subject       VARCHAR(120),
  topic         VARCHAR(180),
  reviewed_at   DATE,
  next_review_date DATE,
  status        ENUM('pendente', 'concluida', 'encerrada') NOT NULL DEFAULT 'pendente',
  difficulty    ENUM('facil', 'medio', 'dificil'),
  notes         TEXT,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_sr_user_status       (user_id, status),
  INDEX idx_sr_user_next_review  (user_id, next_review_date)
);
