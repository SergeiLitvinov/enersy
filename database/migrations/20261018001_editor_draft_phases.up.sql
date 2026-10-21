-- Keep existing v1 journals intact; v2 distinguishes missing preparation evidence.
ALTER TABLE project_editor_drafts DROP CONSTRAINT project_editor_drafts_payload_check;
ALTER TABLE project_editor_drafts ADD CONSTRAINT project_editor_drafts_payload_check
    CHECK (payload IS NULL OR (jsonb_typeof(payload) = 'object'
        AND (payload @> '{"formatVersion":1}'::jsonb OR payload @> '{"formatVersion":2}'::jsonb)
        AND octet_length(payload::text) <= 524288));
