DO $$
BEGIN
    IF EXISTS(SELECT 1 FROM project_study_runs) THEN
        RAISE EXCEPTION 'Cannot downgrade a database containing Study run admissions';
    END IF;
END;
$$;
DROP TABLE project_study_runs;
DROP FUNCTION protect_study_run_admission();
