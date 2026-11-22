-- Short leases for flows that change Cloudflare and then D1 (approve, reject, Cloudflare controls), one per domain.
CREATE TABLE locks (
  key TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  until INTEGER NOT NULL
);
