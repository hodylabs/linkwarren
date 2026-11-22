-- S7 remove: counting and moving a person's links reads them by created_by; without this index both scan every link.
CREATE INDEX links_created_by ON links(created_by);
