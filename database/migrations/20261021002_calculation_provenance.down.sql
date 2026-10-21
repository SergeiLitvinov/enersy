DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM project_calculation_archives WHERE provenance_body IS NOT NULL) THEN
        RAISE EXCEPTION 'Archived provenance must be preserved before downgrade';
    END IF;
END $$;
ALTER TABLE project_calculation_archives DROP CONSTRAINT archive_provenance_pair,
    DROP COLUMN provenance_sha256, DROP COLUMN provenance_body;
