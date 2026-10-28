-- Admission identity stays immutable. Only this separate execution row changes.
CREATE TABLE project_study_run_leases (
    run_id BIGINT PRIMARY KEY REFERENCES project_study_runs(id) ON DELETE CASCADE,
    executor_id UUID NOT NULL,
    generation BIGINT NOT NULL CHECK(generation>0),
    status TEXT NOT NULL CHECK(status IN ('validating','initializing','running','succeeded','failed')),
    lease_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    -- Project deletion cascades through archives and admissions in either order.
    archive_id BIGINT REFERENCES project_calculation_archives(id) DEFERRABLE INITIALLY DEFERRED,
    error_code TEXT CHECK(error_code IN ('worker_unavailable','worker_transport','worker_rejected','invalid_result','archive_quota','lease_exhausted','invalid_snapshot')),
    CHECK((status IN ('validating','initializing','running'))=(lease_until IS NOT NULL)),
    CHECK((status='succeeded')=(archive_id IS NOT NULL)),
    CHECK((status='failed')=(error_code IS NOT NULL))
);
CREATE FUNCTION protect_study_run_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        IF NOT EXISTS(SELECT 1 FROM project_study_runs r JOIN projects p ON p.id=r.project_id WHERE r.id=OLD.run_id) THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'Cannot delete an execution independently' USING ERRCODE='23514';
    END IF;
    IF NEW.run_id<>OLD.run_id OR OLD.status IN ('succeeded','failed') THEN
        RAISE EXCEPTION 'Run identity and terminal execution are immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.generation=OLD.generation+1 THEN
        IF OLD.lease_until>clock_timestamp() OR NEW.status<>'validating' OR NEW.archive_id IS NOT NULL OR NEW.error_code IS NOT NULL THEN
            RAISE EXCEPTION 'Only an expired lease can be reclaimed' USING ERRCODE='23514';
        END IF;
    ELSIF NEW.generation<>OLD.generation OR NEW.executor_id<>OLD.executor_id THEN
        RAISE EXCEPTION 'Invalid execution fencing generation' USING ERRCODE='23514';
    ELSIF NEW.status<>OLD.status AND NOT (
        (OLD.status='validating' AND NEW.status='initializing') OR
        (OLD.status='initializing' AND NEW.status='running') OR
        (OLD.status='running' AND NEW.status='succeeded') OR NEW.status='failed') THEN
        RAISE EXCEPTION 'Invalid execution transition' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER study_run_execution_guard BEFORE UPDATE OR DELETE ON project_study_run_leases
    FOR EACH ROW EXECUTE FUNCTION protect_study_run_execution();
