-- Cancellation does not rewrite immutable admission or manufacture a worker lease.
CREATE TABLE project_study_run_cancellations (
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    command_id UUID NOT NULL,
    run_id BIGINT NOT NULL REFERENCES project_study_runs(id) ON DELETE CASCADE,
    requested_by BIGINT NOT NULL REFERENCES auth_accounts(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (project_id, command_id)
);
CREATE INDEX project_study_run_cancellations_run ON project_study_run_cancellations(run_id);

CREATE FUNCTION guard_study_run_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_project BIGINT;
BEGIN
    IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) THEN
        RETURN OLD;
    END IF;
    IF TG_OP<>'INSERT' THEN
        RAISE EXCEPTION 'Run cancellation commands are immutable' USING ERRCODE='23514';
    END IF;
    -- Same lock as worker claim, including writes outside the application API.
    SELECT project_id INTO run_project FROM project_study_runs WHERE id=NEW.run_id FOR UPDATE;
    IF NOT FOUND OR run_project<>NEW.project_id THEN
        RAISE EXCEPTION 'Cancellation must belong to its run project' USING ERRCODE='23514';
    END IF;
    IF EXISTS(SELECT 1 FROM project_study_run_leases WHERE run_id=NEW.run_id) THEN
        RAISE EXCEPTION 'Only a never-claimed run can be cancelled' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER study_run_cancellation_guard BEFORE INSERT OR UPDATE OR DELETE
ON project_study_run_cancellations FOR EACH ROW EXECUTE FUNCTION guard_study_run_cancellation();

CREATE FUNCTION guard_study_run_claim_after_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM project_study_runs WHERE id=NEW.run_id FOR UPDATE;
    IF EXISTS(SELECT 1 FROM project_study_run_cancellations WHERE run_id=NEW.run_id) THEN
        RAISE EXCEPTION 'A cancelled queued run cannot be claimed' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER study_run_claim_cancellation_guard BEFORE INSERT
ON project_study_run_leases FOR EACH ROW EXECUTE FUNCTION guard_study_run_claim_after_cancellation();
