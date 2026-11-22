-- S5 link rules: a PBKDF2 password hash (NULL = no password) and ordered country/device routes as JSON.
ALTER TABLE links ADD COLUMN password_hash TEXT;
ALTER TABLE links ADD COLUMN routes TEXT NOT NULL DEFAULT '[]';
