-- Initial durable admission ledger. Execution/leases are introduced separately;
-- no successful result or running state can be invented by this migration.
CREATE TABLE project_study_runs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    study_id BIGINT NOT NULL,
    study_revision BIGINT NOT NULL,
    requested_by BIGINT NOT NULL REFERENCES auth_accounts(id),
    command_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status='queued'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    UNIQUE(project_id,command_id),
    FOREIGN KEY(study_id,study_revision) REFERENCES project_study_versions(study_id,revision),
    FOREIGN KEY(study_id,project_id) REFERENCES project_studies(id,project_id)
);
CREATE INDEX project_study_runs_project_page ON project_study_runs(project_id,id);
CREATE FUNCTION protect_study_run_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Study run admissions are immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER study_run_admission_guard BEFORE UPDATE OR DELETE ON project_study_runs
    FOR EACH ROW EXECUTE FUNCTION protect_study_run_admission();
