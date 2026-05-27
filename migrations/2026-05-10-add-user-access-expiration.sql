ALTER TABLE users
  ADD COLUMN access_expires_at DATE NULL AFTER status;

UPDATE users
SET access_expires_at = DATE_ADD(CURRENT_DATE, INTERVAL 30 DAY)
WHERE role = 'student' AND access_expires_at IS NULL;
