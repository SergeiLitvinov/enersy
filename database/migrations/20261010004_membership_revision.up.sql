ALTER TABLE projects ADD COLUMN membership_revision BIGINT NOT NULL DEFAULT 0 CHECK (membership_revision >= 0);
