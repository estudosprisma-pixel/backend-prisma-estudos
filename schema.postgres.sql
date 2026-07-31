-- Prisma Estudos — schema Postgres (Supabase)
-- Consolida schema.sql + migrations/*.sql (MySQL) + as tabelas antes criadas em runtime
-- (study_reviews, user_preferences) num unico schema Postgres.
--
-- Como aplicar: cole este arquivo inteiro no SQL editor do projeto Supabase e rode uma vez.
--
-- Autenticacao: senhas NAO ficam mais em public.users. Quem autentica e cria/verifica senha
-- e o Supabase Auth (auth.users). public.users guarda so os dados de app (nome, role, status,
-- validade de acesso) e seu id EH o mesmo id de auth.users (FK 1:1).
--
-- RLS: deixado desativado de proposito. O backend Express e o unico cliente do banco (conecta
-- direto via connection string, papel equivalente a service role) — o frontend nunca fala com o
-- Supabase diretamente. Reavaliar se isso mudar no futuro.

create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  name varchar(120) not null,
  email varchar(160) not null unique,
  role varchar(20) not null default 'student' check (role in ('admin', 'student')),
  status varchar(20) not null default 'active' check (status in ('active', 'inactive')),
  access_expires_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.study_profiles (
  id varchar(40) primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  objective varchar(255),
  education_context varchar(80),
  daily_minutes int not null default 60,
  available_days jsonb not null default '[]',
  preferred_time varchar(40),
  current_level varchar(20) not null check (current_level in ('iniciante', 'intermediario', 'avancado')),
  review_preference varchar(40) not null,
  topics_per_day int not null default 1,
  mix_subjects boolean not null default true,
  profile_configured boolean not null default false,
  onboarding_completed boolean not null default false
);

create table public.subjects (
  id varchar(40) primary key,
  name varchar(120) not null,
  color varchar(20),
  is_base boolean not null default false,
  owner_user_id uuid references public.users (id) on delete set null,
  created_by_admin_id uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.topics (
  id varchar(40) primary key,
  subject_id varchar(40) not null references public.subjects (id) on delete cascade,
  title varchar(180) not null,
  topic_order int not null,
  suggested_minutes int not null default 45,
  is_base boolean not null default false,
  owner_user_id uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.user_subjects (
  user_id uuid not null references public.users (id) on delete cascade,
  subject_id varchar(40) not null references public.subjects (id) on delete cascade,
  selected_at timestamptz not null default now(),
  primary key (user_id, subject_id)
);

create table public.user_topics (
  user_id uuid not null references public.users (id) on delete cascade,
  topic_id varchar(40) not null references public.topics (id) on delete cascade,
  status varchar(20) not null default 'pendente'
    check (status in ('pendente', 'em_andamento', 'parcial', 'concluido', 'nao_concluido')),
  progress_percent int not null default 0,
  unlocked boolean not null default false,
  theory_read boolean not null default false,
  summary_done boolean not null default false,
  exercises_done boolean not null default false,
  completed_at date,
  primary key (user_id, topic_id)
);

create table public.study_sessions (
  id varchar(40) primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  subject_id varchar(40) not null references public.subjects (id) on delete cascade,
  topic_id varchar(40) not null references public.topics (id) on delete cascade,
  started_at timestamptz not null,
  finished_at timestamptz,
  planned_minutes int not null,
  studied_minutes int not null default 0,
  result varchar(20) not null check (result in ('concluido', 'parcial', 'nao_concluido')),
  notes text
);

create table public.reviews (
  id varchar(40) primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  subject_id varchar(40) not null references public.subjects (id) on delete cascade,
  topic_id varchar(40) not null references public.topics (id) on delete cascade,
  original_study_date date not null,
  due_date date not null,
  review_count int not null default 0,
  status varchar(20) not null default 'pendente' check (status in ('pendente', 'feita', 'encerrada')),
  completed_at date
);

create table public.user_theme_settings (
  user_id uuid primary key references public.users (id) on delete cascade,
  theme_mode varchar(10) not null default 'dark' check (theme_mode in ('dark', 'light')),
  primary_color varchar(20) not null default '#25d4c8',
  secondary_color varchar(20) not null default '#f0a84a',
  card_style varchar(10) not null default 'soft' check (card_style in ('soft', 'glass', 'solid')),
  banner_url varchar(500),
  density varchar(20) not null default 'normal' check (density in ('compact', 'normal', 'comfortable')),
  updated_at timestamptz not null default now()
);

create table public.payment_tokens (
  token varchar(80) primary key,
  email varchar(160) not null,
  customer_email varchar(160),
  plan varchar(20) not null default 'mensal' check (plan in ('mensal', 'trimestral', 'anual')),
  duration_days int not null default 30,
  transaction_id varchar(120) not null unique,
  status varchar(20) not null default 'active',
  used boolean not null default false,
  used_by_user_id uuid references public.users (id) on delete set null,
  used_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.study_reviews (
  id varchar(40) primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  title varchar(255) not null,
  subject varchar(120),
  topic varchar(180),
  reviewed_at date,
  next_review_date date,
  status varchar(20) not null default 'pendente' check (status in ('pendente', 'concluida', 'encerrada')),
  difficulty varchar(10) check (difficulty in ('facil', 'medio', 'dificil')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_sr_user_status on public.study_reviews (user_id, status);
create index idx_sr_user_next_review on public.study_reviews (user_id, next_review_date);

create table public.user_preferences (
  id varchar(40) primary key,
  user_id uuid not null unique references public.users (id) on delete cascade,
  theme varchar(20) not null default 'dark',
  accent_color varchar(30) not null default 'blue',
  study_goal varchar(255) not null default '',
  daily_study_minutes int not null default 60,
  preferred_subjects jsonb not null default '[]',
  notifications_enabled boolean not null default true,
  sound_enabled boolean not null default true,
  layout_mode varchar(20) not null default 'default',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Equivalente ao "ON UPDATE CURRENT_TIMESTAMP" do MySQL para as colunas updated_at.
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_users_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

create trigger trg_study_reviews_updated_at
  before update on public.study_reviews
  for each row execute function public.set_updated_at();

create trigger trg_user_preferences_updated_at
  before update on public.user_preferences
  for each row execute function public.set_updated_at();
