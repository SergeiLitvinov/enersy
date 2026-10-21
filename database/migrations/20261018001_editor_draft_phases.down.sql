-- Never discard or reinterpret v2 journals to satisfy a downgrade.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM project_editor_drafts WHERE payload @> '{"formatVersion":2}'::jsonb) THEN
        RAISE EXCEPTION 'Cannot downgrade editor journals while v2 payloads exist';
    END IF;
END $$;
ALTER TABLE project_editor_drafts DROP CONSTRAINT project_editor_drafts_payload_check;
ALTER TABLE project_editor_drafts ADD CONSTRAINT project_editor_drafts_payload_check
    CHECK (payload IS NULL OR (jsonb_typeof(payload) = 'object'
        AND payload @> '{"formatVersion":1}'::jsonb AND octet_length(payload::text) <= 524288));
