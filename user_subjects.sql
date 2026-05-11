CREATE TABLE user_subjects (
  user_id VARCHAR(40) NOT NULL,
  subject_id VARCHAR(40) NOT NULL,
  selected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, subject_id),
  CONSTRAINT fk_user_subjects_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_user_subjects_subject
    FOREIGN KEY (subject_id) REFERENCES subjects(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
