-- Source bases belong to the stored coefficient, not to a solver or Study.
-- Existing declarations remain unchanged and no historical basis is inferred.
ALTER TABLE scheme_component_params
  ADD COLUMN per_unit_base_profile TEXT,
  ADD COLUMN per_unit_s_base_mva DOUBLE PRECISION,
  ADD COLUMN per_unit_v_base_kv DOUBLE PRECISION,
  ADD CONSTRAINT instance_parameter_base CHECK (
    (per_unit_base_profile IS NULL AND per_unit_s_base_mva IS NULL AND per_unit_v_base_kv IS NULL)
    OR (
      per_unit_base_profile IS NOT NULL AND per_unit_base_profile = 'ac-three-phase-rms-v1'
      AND unit_format_version IS NOT NULL AND unit_format_version = 1
      AND declared_unit IS NOT NULL AND declared_unit = 'p.u.'
      AND per_unit_s_base_mva IS NOT NULL AND per_unit_s_base_mva > 0 AND per_unit_s_base_mva < 'Infinity'::DOUBLE PRECISION
      AND per_unit_v_base_kv IS NOT NULL AND per_unit_v_base_kv > 0 AND per_unit_v_base_kv < 'Infinity'::DOUBLE PRECISION
    )
  );
COMMENT ON COLUMN scheme_component_params.per_unit_s_base_mva IS 'Explicit original three-phase MVA base of this coefficient';
COMMENT ON COLUMN scheme_component_params.per_unit_v_base_kv IS 'Explicit original line-to-line RMS kV base of this coefficient';
