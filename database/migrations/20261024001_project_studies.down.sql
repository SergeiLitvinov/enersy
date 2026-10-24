DO $$
BEGIN
    IF EXISTS(SELECT 1 FROM project_studies) OR EXISTS(SELECT 1 FROM project_study_versions) THEN
        RAISE EXCEPTION 'Cannot downgrade a database containing Study history';
    END IF;
END;
$$;
DROP TABLE project_studies,project_study_versions;
DROP FUNCTION protect_study_version();
DROP FUNCTION protect_study_head();
DROP FUNCTION validate_study_source();
