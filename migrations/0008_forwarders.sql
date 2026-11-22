-- S6b move: a forwarder is a links row with forward_to set (the id of the link it forwards to). No foreign key: a deleted
-- target leaves its forwarders pointing at its locked address.
ALTER TABLE links ADD COLUMN forward_to TEXT;
CREATE INDEX links_forward_to ON links(forward_to) WHERE forward_to IS NOT NULL;
-- Lock checks compare lower(slug_key); without this index they read every lock of the domain.
CREATE INDEX slug_locks_lower ON slug_locks(domain_id, lower(slug_key));
