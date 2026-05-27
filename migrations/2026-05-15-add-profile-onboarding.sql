ALTER TABLE study_profiles
  ADD COLUMN profile_configured BOOLEAN NOT NULL DEFAULT FALSE AFTER mix_subjects,
  ADD COLUMN onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE AFTER profile_configured;
