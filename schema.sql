CREATE TABLE users (
  id VARCHAR(40) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(160) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin', 'student') NOT NULL DEFAULT 'student',
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE study_profiles (
  id VARCHAR(40) PRIMARY KEY,
  user_id VARCHAR(40) NOT NULL,
  objective VARCHAR(255),
  education_context VARCHAR(80),
  daily_minutes INT NOT NULL DEFAULT 60,
  available_days JSON NOT NULL,
  preferred_time VARCHAR(40),
  current_level ENUM('iniciante', 'intermediario', 'avancado') NOT NULL,
  review_preference VARCHAR(40) NOT NULL,
  topics_per_day INT NOT NULL DEFAULT 1,
  mix_subjects BOOLEAN NOT NULL DEFAULT TRUE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE subjects (
  id VARCHAR(40) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  color VARCHAR(20),
  is_base BOOLEAN NOT NULL DEFAULT FALSE,
  owner_user_id VARCHAR(40),
  created_by_admin_id VARCHAR(40),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id),
  FOREIGN KEY (created_by_admin_id) REFERENCES users(id)
);

CREATE TABLE topics (
  id VARCHAR(40) PRIMARY KEY,
  subject_id VARCHAR(40) NOT NULL,
  title VARCHAR(180) NOT NULL,
  topic_order INT NOT NULL,
  suggested_minutes INT NOT NULL DEFAULT 45,
  is_base BOOLEAN NOT NULL DEFAULT FALSE,
  owner_user_id VARCHAR(40),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (subject_id) REFERENCES subjects(id),
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);

CREATE TABLE user_subjects (
  user_id VARCHAR(40) NOT NULL,
  subject_id VARCHAR(40) NOT NULL,
  selected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, subject_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (subject_id) REFERENCES subjects(id)
);

CREATE TABLE user_topics (
  user_id VARCHAR(40) NOT NULL,
  topic_id VARCHAR(40) NOT NULL,
  status ENUM('pendente', 'em_andamento', 'parcial', 'concluido', 'nao_concluido') NOT NULL DEFAULT 'pendente',
  progress_percent INT NOT NULL DEFAULT 0,
  unlocked BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at DATE,
  PRIMARY KEY (user_id, topic_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (topic_id) REFERENCES topics(id)
);

CREATE TABLE study_sessions (
  id VARCHAR(40) PRIMARY KEY,
  user_id VARCHAR(40) NOT NULL,
  subject_id VARCHAR(40) NOT NULL,
  topic_id VARCHAR(40) NOT NULL,
  started_at DATETIME NOT NULL,
  finished_at DATETIME,
  planned_minutes INT NOT NULL,
  studied_minutes INT NOT NULL DEFAULT 0,
  result ENUM('concluido', 'parcial', 'nao_concluido') NOT NULL,
  notes TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (subject_id) REFERENCES subjects(id),
  FOREIGN KEY (topic_id) REFERENCES topics(id)
);

CREATE TABLE reviews (
  id VARCHAR(40) PRIMARY KEY,
  user_id VARCHAR(40) NOT NULL,
  subject_id VARCHAR(40) NOT NULL,
  topic_id VARCHAR(40) NOT NULL,
  original_study_date DATE NOT NULL,
  due_date DATE NOT NULL,
  review_count INT NOT NULL DEFAULT 0,
  status ENUM('pendente', 'feita', 'encerrada') NOT NULL DEFAULT 'pendente',
  completed_at DATE,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (subject_id) REFERENCES subjects(id),
  FOREIGN KEY (topic_id) REFERENCES topics(id)
);

CREATE TABLE user_theme_settings (
  user_id VARCHAR(40) PRIMARY KEY,
  theme_mode ENUM('dark', 'light') NOT NULL DEFAULT 'dark',
  primary_color VARCHAR(20) NOT NULL DEFAULT '#25d4c8',
  secondary_color VARCHAR(20) NOT NULL DEFAULT '#f0a84a',
  card_style ENUM('soft', 'glass', 'solid') NOT NULL DEFAULT 'soft',
  banner_url VARCHAR(500),
  density ENUM('compact', 'normal', 'comfortable') NOT NULL DEFAULT 'normal',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
