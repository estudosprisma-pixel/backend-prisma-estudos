ALTER TABLE payment_tokens
  MODIFY COLUMN plan ENUM('mensal', 'trimestral', 'anual') NOT NULL DEFAULT 'mensal';
