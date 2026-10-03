-- A revision covers the equipment record and its parameter snapshot.
ALTER TABLE scheme_components ADD COLUMN revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0);

CREATE FUNCTION enersy_bump_component_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER component_revision BEFORE UPDATE ON scheme_components
FOR EACH ROW EXECUTE FUNCTION enersy_bump_component_revision();

CREATE FUNCTION enersy_bump_parameter_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' THEN
    UPDATE scheme_components SET revision = revision WHERE id = OLD.scheme_component_id;
    RETURN OLD;
  END IF;
  UPDATE scheme_components SET revision = revision WHERE id = NEW.scheme_component_id;
  IF TG_OP = 'UPDATE' AND OLD.scheme_component_id <> NEW.scheme_component_id THEN
    UPDATE scheme_components SET revision = revision WHERE id = OLD.scheme_component_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER component_parameter_revision AFTER INSERT OR UPDATE OR DELETE ON scheme_component_params
FOR EACH ROW EXECUTE FUNCTION enersy_bump_parameter_revision();
