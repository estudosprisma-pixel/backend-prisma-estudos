INSERT INTO users (id, name, email, password_hash, role, status, access_expires_at)
VALUES
  (
    'u-admin-nat',
    'Nat',
    'nat@prismaestudos.local',
    '$2a$10$EHAVS.bdlgsqtP2.snvYhOBqysLpH6sXYR/4yw2CswXHValZNJCcu',
    'admin',
    'active',
    NULL
  ),
  (
    'u-admin-joao-guilherme',
    'João Guilherme',
    'joao.guilherme@prismaestudos.local',
    '$2a$10$HV4JHhtoA1peSwCm2n0Bm.jzJ.HBq/IAUcNd6YIl0D82SXrma27mG',
    'admin',
    'active',
    NULL
  )
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  password_hash = VALUES(password_hash),
  role = VALUES(role),
  status = VALUES(status),
  access_expires_at = VALUES(access_expires_at);
