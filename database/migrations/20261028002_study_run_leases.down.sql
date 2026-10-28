DO $$
BEGIN
    IF EXISTS(SELECT 1 FROM project_study_run_leases) THEN
        RAISE EXCEPTION 'Cannot downgrade a database containing Run execution history';
    END IF;
END;
$$;
DROP TABLE project_study_run_leases;
DROP FUNCTION protect_study_run_execution();
