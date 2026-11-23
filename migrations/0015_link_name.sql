-- S12 optional link name: a label people search by and see in the dashboard. Null when not set. Never on the redirect path.
ALTER TABLE links ADD COLUMN name TEXT;
