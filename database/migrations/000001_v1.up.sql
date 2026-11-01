-- Enersy database v1: initial pre-release baseline.
-- Fresh installation only; no legacy upgrade or demo accounts.
-- Structure and catalog seed are intentionally versioned together.

--
-- PostgreSQL database dump
--


-- Dumped from database version 15.19
-- Dumped by pg_dump version 15.19


--
-- Name: check_component_passport_binding(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION check_component_passport_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE scheme_project BIGINT; passport_project BIGINT; passport_code TEXT; component_code TEXT;
BEGIN
    IF TG_OP='UPDATE' AND OLD.project_passport_version_id IS DISTINCT FROM NEW.project_passport_version_id THEN
        RAISE EXCEPTION 'Component passport binding is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.project_passport_version_id IS NULL THEN RETURN NEW; END IF;
    SELECT project_id INTO scheme_project FROM circuit_schemes WHERE id=NEW.scheme_id;
    SELECT project_id,component_type_code INTO passport_project,passport_code
        FROM project_passports WHERE id=NEW.project_passport_version_id;
    SELECT code INTO component_code FROM component_types WHERE id=NEW.component_type_id;
    IF scheme_project IS NULL OR scheme_project IS DISTINCT FROM passport_project OR component_code IS DISTINCT FROM passport_code THEN
        RAISE EXCEPTION 'Passport does not belong to the component project and type' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: check_connection_ports(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION check_connection_ports() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE from_domain TEXT; to_domain TEXT;
BEGIN
    SELECT p.domain INTO from_domain FROM scheme_components c JOIN component_type_ports p
        ON p.component_type_id=c.component_type_id WHERE c.id=NEW.from_component_id AND c.scheme_id=NEW.scheme_id AND p.port_name=NEW.from_port;
    SELECT p.domain INTO to_domain FROM scheme_components c JOIN component_type_ports p
        ON p.component_type_id=c.component_type_id WHERE c.id=NEW.to_component_id AND c.scheme_id=NEW.scheme_id AND p.port_name=NEW.to_port;
    IF from_domain IS NULL OR to_domain IS NULL OR from_domain <> to_domain OR
       (NEW.from_component_id=NEW.to_component_id AND NEW.from_port=NEW.to_port) THEN
        RAISE EXCEPTION 'Unknown, incompatible or identical connection ports' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;


--
-- Name: enersy_bump_component_revision(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION enersy_bump_component_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END;
$$;


--
-- Name: enersy_bump_parameter_revision(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION enersy_bump_parameter_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: increment_scheme_topology(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION increment_scheme_topology() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE affected INTEGER[];
BEGIN
    IF TG_OP='INSERT' THEN
        SELECT array_agg(DISTINCT scheme_id) INTO affected FROM new_rows;
    ELSIF TG_OP='DELETE' THEN
        SELECT array_agg(DISTINCT scheme_id) INTO affected FROM old_rows;
    ELSIF TG_TABLE_NAME='scheme_components' THEN
        SELECT array_agg(DISTINCT id) INTO affected FROM (
            SELECT unnest(ARRAY[o.scheme_id,n.scheme_id]) AS id FROM old_rows o JOIN new_rows n USING(id)
            WHERE o.scheme_id IS DISTINCT FROM n.scheme_id OR o.component_type_id IS DISTINCT FROM n.component_type_id
        ) changed;
    ELSE
        SELECT array_agg(DISTINCT id) INTO affected FROM (
            SELECT unnest(ARRAY[o.scheme_id,n.scheme_id]) AS id FROM old_rows o JOIN new_rows n USING(id)
            WHERE o.scheme_id IS DISTINCT FROM n.scheme_id OR o.from_component_id IS DISTINCT FROM n.from_component_id
               OR o.to_component_id IS DISTINCT FROM n.to_component_id OR o.from_port IS DISTINCT FROM n.from_port
               OR o.to_port IS DISTINCT FROM n.to_port
        ) changed;
    END IF;
    -- One increment per affected scheme/statement, including bulk imports.
    PERFORM id FROM circuit_schemes WHERE id=ANY(affected) ORDER BY id FOR UPDATE;
    UPDATE circuit_schemes SET topology_revision=topology_revision+1 WHERE id=ANY(affected);
    RETURN NULL;
END; $$;


--
-- Name: protect_bound_scheme_project(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION protect_bound_scheme_project() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.project_id IS DISTINCT FROM NEW.project_id AND EXISTS
        (SELECT 1 FROM scheme_components WHERE scheme_id=OLD.id AND project_passport_version_id IS NOT NULL) THEN
        RAISE EXCEPTION 'A scheme with bound passports cannot change project' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: protect_study_head(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION protect_study_head() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.scheme_id IS DISTINCT FROM OLD.scheme_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.current_revision<>OLD.current_revision+1 THEN
        RAISE EXCEPTION 'Study identity is immutable and revisions advance by one' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: protect_study_run_admission(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION protect_study_run_admission() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Study run admissions are immutable' USING ERRCODE='23514';
END;
$$;


--
-- Name: protect_study_run_execution(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION protect_study_run_execution() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: protect_study_version(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION protect_study_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- A project-wide deletion may remove its private history. There is no
    -- standalone version deletion API, and direct edits/deletes are rejected.
    IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Study versions are immutable' USING ERRCODE='23514';
END;
$$;


--
-- Name: reject_calculation_archive_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION reject_calculation_archive_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'Calculation archives are immutable' USING ERRCODE = '23514';
END;
$$;


--
-- Name: reject_project_passport_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION reject_project_passport_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'Project passport versions are immutable' USING ERRCODE = '23514';
END;
$$;


--
-- Name: validate_study_source(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION validate_study_source() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM id FROM circuit_schemes WHERE id=NEW.scheme_id AND project_id=NEW.project_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Study source must belong to its project at capture' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;




--
-- Name: auth_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE auth_accounts (
    id bigint NOT NULL,
    display_name text NOT NULL,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    disabled_at timestamp with time zone,
    CONSTRAINT auth_accounts_display_name_check CHECK ((length(btrim(display_name)) > 0))
);


--
-- Name: auth_accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE auth_accounts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auth_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE auth_accounts_id_seq OWNED BY auth_accounts.id;


--
-- Name: auth_local_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE auth_local_credentials (
    account_id bigint NOT NULL,
    login text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    CONSTRAINT auth_local_credentials_login_check CHECK ((login ~ '^[a-z0-9][a-z0-9._-]{2,63}$'::text)),
    CONSTRAINT auth_local_credentials_password_hash_check CHECK (((length(password_hash) >= 1) AND (length(password_hash) <= 256)))
);


--
-- Name: auth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE auth_sessions (
    id bigint NOT NULL,
    account_id bigint NOT NULL,
    token_hash bytea NOT NULL,
    issued_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT auth_sessions_check CHECK ((expires_at > issued_at)),
    CONSTRAINT auth_sessions_check1 CHECK (((revoked_at IS NULL) OR (revoked_at >= issued_at))),
    CONSTRAINT auth_sessions_token_hash_check CHECK ((octet_length(token_hash) = 32))
);


--
-- Name: auth_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE auth_sessions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auth_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE auth_sessions_id_seq OWNED BY auth_sessions.id;


--
-- Name: circuit_schemes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE circuit_schemes (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    project_id bigint,
    topology_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT circuit_schemes_topology_revision_check CHECK ((topology_revision >= 0))
);


--
-- Name: circuit_schemes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE circuit_schemes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: circuit_schemes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE circuit_schemes_id_seq OWNED BY circuit_schemes.id;


--
-- Name: component_params_template; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE component_params_template (
    id integer NOT NULL,
    component_type_id integer,
    param_key character varying(50) NOT NULL,
    param_name character varying(100) NOT NULL,
    param_type character varying(20) NOT NULL,
    default_value text,
    unit character varying(20)
);


--
-- Name: component_params_template_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE component_params_template_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: component_params_template_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE component_params_template_id_seq OWNED BY component_params_template.id;


--
-- Name: component_type_ports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE component_type_ports (
    component_type_id integer NOT NULL,
    port_name character varying(50) NOT NULL,
    domain character varying(50) NOT NULL
);


--
-- Name: component_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE component_types (
    id integer NOT NULL,
    code character varying(50) NOT NULL,
    name character varying(100) NOT NULL,
    category character varying(50) NOT NULL,
    description text
);


--
-- Name: component_types_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE component_types_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: component_types_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE component_types_id_seq OWNED BY component_types.id;


--
-- Name: connection_commands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE connection_commands (
    scheme_id integer NOT NULL,
    command_id uuid NOT NULL,
    payload_hash bytea NOT NULL,
    connection_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT connection_commands_connection_id_check CHECK ((connection_id > 0)),
    CONSTRAINT connection_commands_payload_hash_check CHECK ((octet_length(payload_hash) = 32))
);


--
-- Name: equipment_model_params; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE equipment_model_params (
    id integer NOT NULL,
    equipment_model_id integer,
    param_key character varying(50) NOT NULL,
    param_value text NOT NULL
);


--
-- Name: equipment_model_params_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE equipment_model_params_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: equipment_model_params_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE equipment_model_params_id_seq OWNED BY equipment_model_params.id;


--
-- Name: equipment_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE equipment_models (
    id integer NOT NULL,
    component_type_id integer,
    model_name character varying(100) NOT NULL,
    manufacturer character varying(100),
    description text
);


--
-- Name: equipment_models_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE equipment_models_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: equipment_models_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE equipment_models_id_seq OWNED BY equipment_models.id;


--
-- Name: scheme_components; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE scheme_components (
    id integer NOT NULL,
    scheme_id integer,
    component_type_id integer,
    custom_name character varying(100),
    pos_x real DEFAULT 0 NOT NULL,
    pos_y real DEFAULT 0 NOT NULL,
    rotation integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    equipment_model_id integer,
    revision bigint DEFAULT 1 NOT NULL,
    project_passport_version_id bigint,
    CONSTRAINT component_one_passport CHECK (((equipment_model_id IS NULL) OR (project_passport_version_id IS NULL))),
    CONSTRAINT scheme_components_revision_check CHECK ((revision > 0))
);


--
-- Name: scheme_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE scheme_connections (
    id integer NOT NULL,
    scheme_id integer,
    from_component_id integer,
    to_component_id integer,
    from_port character varying(50) NOT NULL,
    to_port character varying(50) NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: invalid_scheme_connections; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW invalid_scheme_connections AS
 SELECT c.id,
    c.scheme_id,
    c.from_component_id,
    c.to_component_id,
    c.from_port,
    c.to_port,
    c.created_at,
    array_remove(ARRAY[
        CASE
            WHEN ((c.scheme_id IS NULL) OR (f.scheme_id IS DISTINCT FROM c.scheme_id) OR (t.scheme_id IS DISTINCT FROM c.scheme_id)) THEN 'scheme_mismatch'::text
            ELSE NULL::text
        END,
        CASE
            WHEN ((fp.domain IS NULL) OR (tp.domain IS NULL)) THEN 'unknown_port'::text
            ELSE NULL::text
        END,
        CASE
            WHEN ((fp.domain IS NOT NULL) AND (tp.domain IS NOT NULL) AND ((fp.domain)::text <> (tp.domain)::text)) THEN 'domain_mismatch'::text
            ELSE NULL::text
        END,
        CASE
            WHEN ((c.from_component_id = c.to_component_id) AND ((c.from_port)::text = (c.to_port)::text)) THEN 'identical_port'::text
            ELSE NULL::text
        END], NULL::text) AS reasons
   FROM ((((scheme_connections c
     LEFT JOIN scheme_components f ON ((f.id = c.from_component_id)))
     LEFT JOIN scheme_components t ON ((t.id = c.to_component_id)))
     LEFT JOIN component_type_ports fp ON (((fp.component_type_id = f.component_type_id) AND ((fp.port_name)::text = (c.from_port)::text))))
     LEFT JOIN component_type_ports tp ON (((tp.component_type_id = t.component_type_id) AND ((tp.port_name)::text = (c.to_port)::text))))
  WHERE ((c.scheme_id IS NULL) OR (f.scheme_id IS DISTINCT FROM c.scheme_id) OR (t.scheme_id IS DISTINCT FROM c.scheme_id) OR (fp.domain IS NULL) OR (tp.domain IS NULL) OR ((fp.domain)::text <> (tp.domain)::text) OR ((c.from_component_id = c.to_component_id) AND ((c.from_port)::text = (c.to_port)::text)));


--
-- Name: project_calculation_archives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE project_calculation_archives (
    id bigint NOT NULL,
    project_id bigint NOT NULL,
    scheme_id integer NOT NULL,
    scheme_name text NOT NULL,
    author_account_id bigint NOT NULL,
    topology_revision bigint NOT NULL,
    model_group text NOT NULL,
    method text NOT NULL,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    input_body bytea NOT NULL,
    result_body bytea NOT NULL,
    input_sha256 text NOT NULL,
    result_sha256 text NOT NULL,
    provenance_body bytea,
    provenance_sha256 text,
    CONSTRAINT archive_provenance_pair CHECK ((((provenance_body IS NULL) AND (provenance_sha256 IS NULL)) OR ((provenance_body IS NOT NULL) AND (provenance_sha256 IS NOT NULL) AND ((octet_length(provenance_body) >= 1) AND (octet_length(provenance_body) <= 8388608)) AND (provenance_sha256 ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT project_calculation_archives_input_body_check CHECK (((octet_length(input_body) >= 1) AND (octet_length(input_body) <= 8388608))),
    CONSTRAINT project_calculation_archives_input_sha256_check CHECK ((input_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT project_calculation_archives_method_check CHECK (((length(method) >= 1) AND (length(method) <= 64))),
    CONSTRAINT project_calculation_archives_model_group_check CHECK (((length(model_group) >= 1) AND (length(model_group) <= 64))),
    CONSTRAINT project_calculation_archives_result_body_check CHECK (((octet_length(result_body) >= 1) AND (octet_length(result_body) <= 8388608))),
    CONSTRAINT project_calculation_archives_result_sha256_check CHECK ((result_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT project_calculation_archives_scheme_id_check CHECK ((scheme_id > 0)),
    CONSTRAINT project_calculation_archives_topology_revision_check CHECK ((topology_revision >= 0))
);


--
-- Name: project_calculation_archives_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE project_calculation_archives ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME project_calculation_archives_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: project_editor_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE project_editor_drafts (
    account_id bigint NOT NULL,
    scheme_id integer NOT NULL,
    workspace_id uuid NOT NULL,
    revision bigint NOT NULL,
    payload jsonb,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT project_editor_drafts_check CHECK ((((deleted_at IS NULL) AND (payload IS NOT NULL)) OR ((deleted_at IS NOT NULL) AND (payload IS NULL)))),
    CONSTRAINT project_editor_drafts_payload_check CHECK (((payload IS NULL) OR ((jsonb_typeof(payload) = 'object'::text) AND ((payload @> '{"formatVersion": 1}'::jsonb) OR (payload @> '{"formatVersion": 2}'::jsonb)) AND (octet_length((payload)::text) <= 524288)))),
    CONSTRAINT project_editor_drafts_revision_check CHECK ((revision > 0))
);


--
-- Name: project_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE project_members (
    project_id bigint NOT NULL,
    account_id bigint NOT NULL,
    role text NOT NULL,
    CONSTRAINT project_members_role_check CHECK ((role = ANY (ARRAY['viewer'::text, 'editor'::text, 'admin'::text])))
);


--
-- Name: project_passports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE project_passports (
    id bigint NOT NULL,
    project_id bigint NOT NULL,
    author_account_id bigint NOT NULL,
    command_id uuid NOT NULL,
    predecessor_id bigint,
    revision integer NOT NULL,
    component_type_code character varying(50) NOT NULL,
    document bytea NOT NULL,
    sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    CONSTRAINT project_passports_check CHECK ((((predecessor_id IS NULL) AND (revision = 1)) OR ((predecessor_id IS NOT NULL) AND (revision > 1)))),
    CONSTRAINT project_passports_document_check CHECK (((octet_length(document) >= 1) AND (octet_length(document) <= 65536))),
    CONSTRAINT project_passports_revision_check CHECK ((revision > 0)),
    CONSTRAINT project_passports_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: project_passports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE project_passports ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME project_passports_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: project_studies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE project_studies (
    id bigint NOT NULL,
    project_id bigint NOT NULL,
    scheme_id integer NOT NULL,
    current_revision bigint NOT NULL,
    created_by bigint NOT NULL,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    CONSTRAINT project_studies_current_revision_check CHECK ((current_revision > 0)),
    CONSTRAINT project_studies_scheme_id_check CHECK ((scheme_id > 0))
);


--
-- Name: project_studies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE project_studies ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME project_studies_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: project_study_run_leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE project_study_run_leases (
    run_id bigint NOT NULL,
    executor_id uuid NOT NULL,
    generation bigint NOT NULL,
    status text NOT NULL,
    lease_until timestamp with time zone,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    archive_id bigint,
    error_code text,
    CONSTRAINT project_study_run_leases_check CHECK (((status = ANY (ARRAY['validating'::text, 'initializing'::text, 'running'::text])) = (lease_until IS NOT NULL))),
    CONSTRAINT project_study_run_leases_check1 CHECK (((status = 'succeeded'::text) = (archive_id IS NOT NULL))),
    CONSTRAINT project_study_run_leases_check2 CHECK (((status = 'failed'::text) = (error_code IS NOT NULL))),
    CONSTRAINT project_study_run_leases_error_code_check CHECK ((error_code = ANY (ARRAY['worker_unavailable'::text, 'worker_transport'::text, 'worker_rejected'::text, 'invalid_result'::text, 'archive_quota'::text, 'lease_exhausted'::text, 'invalid_snapshot'::text]))),
    CONSTRAINT project_study_run_leases_generation_check CHECK ((generation > 0)),
    CONSTRAINT project_study_run_leases_status_check CHECK ((status = ANY (ARRAY['validating'::text, 'initializing'::text, 'running'::text, 'succeeded'::text, 'failed'::text])))
);


--
-- Name: project_study_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE project_study_runs (
    id bigint NOT NULL,
    project_id bigint NOT NULL,
    study_id bigint NOT NULL,
    study_revision bigint NOT NULL,
    requested_by bigint NOT NULL,
    command_id uuid NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    CONSTRAINT project_study_runs_status_check CHECK ((status = 'queued'::text))
);


--
-- Name: project_study_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE project_study_runs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME project_study_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: project_study_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE project_study_versions (
    study_id bigint NOT NULL,
    project_id bigint NOT NULL,
    revision bigint NOT NULL,
    author_account_id bigint NOT NULL,
    command_id uuid NOT NULL,
    command_sha256 text NOT NULL,
    topology_revision bigint NOT NULL,
    scheme_name text NOT NULL,
    document jsonb NOT NULL,
    input_body bytea NOT NULL,
    provenance_body bytea NOT NULL,
    input_sha256 text GENERATED ALWAYS AS (encode(sha256(input_body), 'hex'::text)) STORED,
    provenance_sha256 text GENERATED ALWAYS AS (encode(sha256(provenance_body), 'hex'::text)) STORED,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    CONSTRAINT project_study_versions_command_sha256_check CHECK ((command_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT project_study_versions_document_check CHECK (((jsonb_typeof(document) = 'object'::text) AND (document @> '{"formatVersion": 1}'::jsonb) AND (octet_length((document)::text) <= 131072))),
    CONSTRAINT project_study_versions_input_body_check CHECK (((octet_length(input_body) >= 1) AND (octet_length(input_body) <= 8388608))),
    CONSTRAINT project_study_versions_provenance_body_check CHECK (((octet_length(provenance_body) >= 1) AND (octet_length(provenance_body) <= 8388608))),
    CONSTRAINT project_study_versions_revision_check CHECK ((revision > 0)),
    CONSTRAINT project_study_versions_topology_revision_check CHECK ((topology_revision >= 0))
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE projects (
    id bigint NOT NULL,
    owner_account_id bigint NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    membership_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT projects_membership_revision_check CHECK ((membership_revision >= 0)),
    CONSTRAINT projects_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 200)))
);


--
-- Name: projects_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE projects_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: projects_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE projects_id_seq OWNED BY projects.id;


--
-- Name: scheme_component_params; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE scheme_component_params (
    id integer NOT NULL,
    scheme_component_id integer,
    param_key character varying(50) NOT NULL,
    param_value text NOT NULL,
    unit_format_version smallint,
    declared_unit text,
    CONSTRAINT instance_parameter_unit_declaration CHECK ((((unit_format_version IS NULL) AND (declared_unit IS NULL)) OR ((unit_format_version IS NOT NULL) AND (unit_format_version = 1) AND (declared_unit IS NOT NULL) AND ((length(declared_unit) >= 1) AND (length(declared_unit) <= 64)) AND (declared_unit = btrim(declared_unit)) AND (declared_unit !~ '[[:cntrl:]]'::text))))
);


--
-- Name: scheme_component_params_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE scheme_component_params_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: scheme_component_params_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE scheme_component_params_id_seq OWNED BY scheme_component_params.id;


--
-- Name: scheme_components_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE scheme_components_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: scheme_components_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE scheme_components_id_seq OWNED BY scheme_components.id;


--
-- Name: scheme_connections_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE scheme_connections_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: scheme_connections_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE scheme_connections_id_seq OWNED BY scheme_connections.id;


--
-- Name: auth_accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY auth_accounts ALTER COLUMN id SET DEFAULT nextval('auth_accounts_id_seq'::regclass);


--
-- Name: auth_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY auth_sessions ALTER COLUMN id SET DEFAULT nextval('auth_sessions_id_seq'::regclass);


--
-- Name: circuit_schemes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY circuit_schemes ALTER COLUMN id SET DEFAULT nextval('circuit_schemes_id_seq'::regclass);


--
-- Name: component_params_template id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY component_params_template ALTER COLUMN id SET DEFAULT nextval('component_params_template_id_seq'::regclass);


--
-- Name: component_types id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY component_types ALTER COLUMN id SET DEFAULT nextval('component_types_id_seq'::regclass);


--
-- Name: equipment_model_params id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY equipment_model_params ALTER COLUMN id SET DEFAULT nextval('equipment_model_params_id_seq'::regclass);


--
-- Name: equipment_models id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY equipment_models ALTER COLUMN id SET DEFAULT nextval('equipment_models_id_seq'::regclass);


--
-- Name: projects id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY projects ALTER COLUMN id SET DEFAULT nextval('projects_id_seq'::regclass);


--
-- Name: scheme_component_params id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY scheme_component_params ALTER COLUMN id SET DEFAULT nextval('scheme_component_params_id_seq'::regclass);


--
-- Name: scheme_components id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY scheme_components ALTER COLUMN id SET DEFAULT nextval('scheme_components_id_seq'::regclass);


--
-- Name: scheme_connections id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY scheme_connections ALTER COLUMN id SET DEFAULT nextval('scheme_connections_id_seq'::regclass);


--
-- Name: auth_accounts auth_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY auth_accounts
    ADD CONSTRAINT auth_accounts_pkey PRIMARY KEY (id);


--
-- Name: auth_local_credentials auth_local_credentials_login_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY auth_local_credentials
    ADD CONSTRAINT auth_local_credentials_login_key UNIQUE (login);


--
-- Name: auth_local_credentials auth_local_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY auth_local_credentials
    ADD CONSTRAINT auth_local_credentials_pkey PRIMARY KEY (account_id);


--
-- Name: auth_sessions auth_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id);


--
-- Name: auth_sessions auth_sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY auth_sessions
    ADD CONSTRAINT auth_sessions_token_hash_key UNIQUE (token_hash);


--
-- Name: circuit_schemes circuit_schemes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY circuit_schemes
    ADD CONSTRAINT circuit_schemes_pkey PRIMARY KEY (id);


--
-- Name: component_params_template component_params_template_component_type_id_param_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY component_params_template
    ADD CONSTRAINT component_params_template_component_type_id_param_key_key UNIQUE (component_type_id, param_key);


--
-- Name: component_params_template component_params_template_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY component_params_template
    ADD CONSTRAINT component_params_template_pkey PRIMARY KEY (id);


--
-- Name: component_type_ports component_type_ports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY component_type_ports
    ADD CONSTRAINT component_type_ports_pkey PRIMARY KEY (component_type_id, port_name);


--
-- Name: component_types component_types_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY component_types
    ADD CONSTRAINT component_types_code_key UNIQUE (code);


--
-- Name: component_types component_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY component_types
    ADD CONSTRAINT component_types_pkey PRIMARY KEY (id);


--
-- Name: connection_commands connection_commands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY connection_commands
    ADD CONSTRAINT connection_commands_pkey PRIMARY KEY (scheme_id, command_id);


--
-- Name: equipment_model_params equipment_model_params_equipment_model_id_param_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY equipment_model_params
    ADD CONSTRAINT equipment_model_params_equipment_model_id_param_key_key UNIQUE (equipment_model_id, param_key);


--
-- Name: equipment_model_params equipment_model_params_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY equipment_model_params
    ADD CONSTRAINT equipment_model_params_pkey PRIMARY KEY (id);


--
-- Name: equipment_models equipment_models_component_type_id_model_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY equipment_models
    ADD CONSTRAINT equipment_models_component_type_id_model_name_key UNIQUE (component_type_id, model_name);


--
-- Name: equipment_models equipment_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY equipment_models
    ADD CONSTRAINT equipment_models_pkey PRIMARY KEY (id);


--
-- Name: project_calculation_archives project_calculation_archives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_calculation_archives
    ADD CONSTRAINT project_calculation_archives_pkey PRIMARY KEY (id);


--
-- Name: project_editor_drafts project_editor_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_editor_drafts
    ADD CONSTRAINT project_editor_drafts_pkey PRIMARY KEY (account_id, scheme_id, workspace_id);


--
-- Name: project_members project_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_members
    ADD CONSTRAINT project_members_pkey PRIMARY KEY (project_id, account_id);


--
-- Name: project_passports project_passports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_passports
    ADD CONSTRAINT project_passports_pkey PRIMARY KEY (id);


--
-- Name: project_passports project_passports_predecessor_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_passports
    ADD CONSTRAINT project_passports_predecessor_id_key UNIQUE (predecessor_id);


--
-- Name: project_passports project_passports_project_id_command_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_passports
    ADD CONSTRAINT project_passports_project_id_command_id_key UNIQUE (project_id, command_id);


--
-- Name: project_passports project_passports_project_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_passports
    ADD CONSTRAINT project_passports_project_id_id_key UNIQUE (project_id, id);


--
-- Name: project_studies project_studies_id_project_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_studies
    ADD CONSTRAINT project_studies_id_project_id_key UNIQUE (id, project_id);


--
-- Name: project_studies project_studies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_studies
    ADD CONSTRAINT project_studies_pkey PRIMARY KEY (id);


--
-- Name: project_study_run_leases project_study_run_leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_study_run_leases
    ADD CONSTRAINT project_study_run_leases_pkey PRIMARY KEY (run_id);


--
-- Name: project_study_runs project_study_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_study_runs
    ADD CONSTRAINT project_study_runs_pkey PRIMARY KEY (id);


--
-- Name: project_study_runs project_study_runs_project_id_command_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_study_runs
    ADD CONSTRAINT project_study_runs_project_id_command_id_key UNIQUE (project_id, command_id);


--
-- Name: project_study_versions project_study_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_study_versions
    ADD CONSTRAINT project_study_versions_pkey PRIMARY KEY (study_id, revision);


--
-- Name: project_study_versions project_study_versions_project_id_command_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_study_versions
    ADD CONSTRAINT project_study_versions_project_id_command_id_key UNIQUE (project_id, command_id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: scheme_component_params scheme_component_params_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY scheme_component_params
    ADD CONSTRAINT scheme_component_params_pkey PRIMARY KEY (id);


--
-- Name: scheme_component_params scheme_component_params_scheme_component_id_param_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY scheme_component_params
    ADD CONSTRAINT scheme_component_params_scheme_component_id_param_key_key UNIQUE (scheme_component_id, param_key);


--
-- Name: scheme_components scheme_components_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY scheme_components
    ADD CONSTRAINT scheme_components_pkey PRIMARY KEY (id);


--
-- Name: scheme_connections scheme_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY scheme_connections
    ADD CONSTRAINT scheme_connections_pkey PRIMARY KEY (id);


--
-- Name: auth_sessions_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_sessions_account_idx ON auth_sessions USING btree (account_id);


--
-- Name: circuit_schemes_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX circuit_schemes_project_idx ON circuit_schemes USING btree (project_id);


--
-- Name: equipment_models_id_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX equipment_models_id_type_idx ON equipment_models USING btree (id, component_type_id);


--
-- Name: project_calculation_archives_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_calculation_archives_page ON project_calculation_archives USING btree (project_id, id DESC);


--
-- Name: project_editor_drafts_account_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_editor_drafts_account_active ON project_editor_drafts USING btree (account_id, scheme_id, updated_at DESC, workspace_id) WHERE (deleted_at IS NULL);


--
-- Name: project_members_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_members_account_idx ON project_members USING btree (account_id, project_id);


--
-- Name: project_passports_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_passports_page ON project_passports USING btree (project_id, id);


--
-- Name: project_studies_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_studies_page ON project_studies USING btree (project_id, id);


--
-- Name: project_study_runs_project_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_study_runs_project_page ON project_study_runs USING btree (project_id, id);


--
-- Name: project_study_versions_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_study_versions_project ON project_study_versions USING btree (project_id);


--
-- Name: projects_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX projects_owner_idx ON projects USING btree (owner_account_id);


--
-- Name: scheme_components_id_scheme_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX scheme_components_id_scheme_idx ON scheme_components USING btree (id, scheme_id);


--
-- Name: scheme_components_scheme_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scheme_components_scheme_idx ON scheme_components USING btree (scheme_id);


--
-- Name: scheme_connections_from_scheme_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scheme_connections_from_scheme_idx ON scheme_connections USING btree (from_component_id, scheme_id);


--
-- Name: scheme_connections_scheme_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scheme_connections_scheme_idx ON scheme_connections USING btree (scheme_id);


--
-- Name: scheme_connections_to_scheme_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scheme_connections_to_scheme_idx ON scheme_connections USING btree (to_component_id, scheme_id);


--
-- Name: circuit_schemes bound_scheme_project; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER bound_scheme_project BEFORE UPDATE OF project_id ON circuit_schemes FOR EACH ROW EXECUTE FUNCTION protect_bound_scheme_project();


--
-- Name: project_calculation_archives calculation_archive_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER calculation_archive_immutable BEFORE UPDATE ON project_calculation_archives FOR EACH ROW EXECUTE FUNCTION reject_calculation_archive_update();


--
-- Name: scheme_component_params component_parameter_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER component_parameter_revision AFTER INSERT OR DELETE OR UPDATE ON scheme_component_params FOR EACH ROW EXECUTE FUNCTION enersy_bump_parameter_revision();


--
-- Name: scheme_components component_passport_binding; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER component_passport_binding BEFORE INSERT OR UPDATE ON scheme_components FOR EACH ROW EXECUTE FUNCTION check_component_passport_binding();


--
-- Name: scheme_components component_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER component_revision BEFORE UPDATE ON scheme_components FOR EACH ROW EXECUTE FUNCTION enersy_bump_component_revision();


--
-- Name: scheme_components component_topology_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER component_topology_delete AFTER DELETE ON scheme_components REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION increment_scheme_topology();


--
-- Name: scheme_components component_topology_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER component_topology_insert AFTER INSERT ON scheme_components REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION increment_scheme_topology();


--
-- Name: scheme_components component_topology_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER component_topology_update AFTER UPDATE ON scheme_components REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION increment_scheme_topology();


--
-- Name: scheme_connections connection_ports_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER connection_ports_check BEFORE INSERT OR UPDATE ON scheme_connections FOR EACH ROW EXECUTE FUNCTION check_connection_ports();


--
-- Name: scheme_connections connection_topology_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER connection_topology_delete AFTER DELETE ON scheme_connections REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION increment_scheme_topology();


--
-- Name: scheme_connections connection_topology_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER connection_topology_insert AFTER INSERT ON scheme_connections REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION increment_scheme_topology();


--
-- Name: scheme_connections connection_topology_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER connection_topology_update AFTER UPDATE ON scheme_connections REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION increment_scheme_topology();


--
-- Name: project_passports project_passport_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER project_passport_immutable BEFORE UPDATE ON project_passports FOR EACH ROW EXECUTE FUNCTION reject_project_passport_update();


--
-- Name: project_studies study_head_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER study_head_guard BEFORE UPDATE ON project_studies FOR EACH ROW EXECUTE FUNCTION protect_study_head();


--
-- Name: project_study_runs study_run_admission_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER study_run_admission_guard BEFORE DELETE OR UPDATE ON project_study_runs FOR EACH ROW EXECUTE FUNCTION protect_study_run_admission();


--
-- Name: project_study_run_leases study_run_execution_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER study_run_execution_guard BEFORE DELETE OR UPDATE ON project_study_run_leases FOR EACH ROW EXECUTE FUNCTION protect_study_run_execution();


--
-- Name: project_studies study_source_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER study_source_guard BEFORE INSERT ON project_studies FOR EACH ROW EXECUTE FUNCTION validate_study_source();


--
-- Name: project_study_versions study_version_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER study_version_immutable BEFORE DELETE OR UPDATE ON project_study_versions FOR EACH ROW EXECUTE FUNCTION protect_study_version();


--
-- Name: auth_local_credentials auth_local_credentials_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY auth_local_credentials
    ADD CONSTRAINT auth_local_credentials_account_id_fkey FOREIGN KEY (account_id) REFERENCES auth_accounts(id) ON DELETE CASCADE;


--
-- Name: auth_sessions auth_sessions_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY auth_sessions
    ADD CONSTRAINT auth_sessions_account_id_fkey FOREIGN KEY (account_id) REFERENCES auth_accounts(id) ON DELETE CASCADE;


--
-- Name: circuit_schemes circuit_schemes_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY circuit_schemes
    ADD CONSTRAINT circuit_schemes_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;


--
-- Name: component_params_template component_params_template_component_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY component_params_template
    ADD CONSTRAINT component_params_template_component_type_id_fkey FOREIGN KEY (component_type_id) REFERENCES component_types(id);


--
-- Name: component_type_ports component_type_ports_component_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY component_type_ports
    ADD CONSTRAINT component_type_ports_component_type_id_fkey FOREIGN KEY (component_type_id) REFERENCES component_types(id);


--
-- Name: connection_commands connection_commands_scheme_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY connection_commands
    ADD CONSTRAINT connection_commands_scheme_id_fkey FOREIGN KEY (scheme_id) REFERENCES circuit_schemes(id) ON DELETE CASCADE;


--
-- Name: scheme_connections connection_from_scheme_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY scheme_connections
    ADD CONSTRAINT connection_from_scheme_fk FOREIGN KEY (from_component_id, scheme_id) REFERENCES scheme_components(id, scheme_id) ON DELETE CASCADE;


--
-- Name: scheme_connections connection_to_scheme_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY scheme_connections
    ADD CONSTRAINT connection_to_scheme_fk FOREIGN KEY (to_component_id, scheme_id) REFERENCES scheme_components(id, scheme_id) ON DELETE CASCADE;


--
-- Name: equipment_model_params equipment_model_params_equipment_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY equipment_model_params
    ADD CONSTRAINT equipment_model_params_equipment_model_id_fkey FOREIGN KEY (equipment_model_id) REFERENCES equipment_models(id) ON DELETE CASCADE;


--
-- Name: equipment_models equipment_models_component_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY equipment_models
    ADD CONSTRAINT equipment_models_component_type_id_fkey FOREIGN KEY (component_type_id) REFERENCES component_types(id);


--
-- Name: project_calculation_archives project_calculation_archives_author_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_calculation_archives
    ADD CONSTRAINT project_calculation_archives_author_account_id_fkey FOREIGN KEY (author_account_id) REFERENCES auth_accounts(id);


--
-- Name: project_calculation_archives project_calculation_archives_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_calculation_archives
    ADD CONSTRAINT project_calculation_archives_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: project_editor_drafts project_editor_drafts_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_editor_drafts
    ADD CONSTRAINT project_editor_drafts_account_id_fkey FOREIGN KEY (account_id) REFERENCES auth_accounts(id) ON DELETE CASCADE;


--
-- Name: project_editor_drafts project_editor_drafts_scheme_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_editor_drafts
    ADD CONSTRAINT project_editor_drafts_scheme_id_fkey FOREIGN KEY (scheme_id) REFERENCES circuit_schemes(id) ON DELETE CASCADE;


--
-- Name: project_members project_members_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_members
    ADD CONSTRAINT project_members_account_id_fkey FOREIGN KEY (account_id) REFERENCES auth_accounts(id) ON DELETE CASCADE;


--
-- Name: project_members project_members_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_members
    ADD CONSTRAINT project_members_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: project_passports project_passports_author_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_passports
    ADD CONSTRAINT project_passports_author_account_id_fkey FOREIGN KEY (author_account_id) REFERENCES auth_accounts(id);


--
-- Name: project_passports project_passports_component_type_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_passports
    ADD CONSTRAINT project_passports_component_type_code_fkey FOREIGN KEY (component_type_code) REFERENCES component_types(code);


--
-- Name: project_passports project_passports_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_passports
    ADD CONSTRAINT project_passports_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: project_passports project_passports_project_id_predecessor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_passports
    ADD CONSTRAINT project_passports_project_id_predecessor_id_fkey FOREIGN KEY (project_id, predecessor_id) REFERENCES project_passports(project_id, id);


--
-- Name: project_studies project_studies_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_studies
    ADD CONSTRAINT project_studies_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth_accounts(id);


--
-- Name: project_studies project_studies_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_studies
    ADD CONSTRAINT project_studies_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: project_studies project_study_head; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_studies
    ADD CONSTRAINT project_study_head FOREIGN KEY (id, current_revision) REFERENCES project_study_versions(study_id, revision) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: project_study_run_leases project_study_run_leases_archive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_study_run_leases
    ADD CONSTRAINT project_study_run_leases_archive_id_fkey FOREIGN KEY (archive_id) REFERENCES project_calculation_archives(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: project_study_run_leases project_study_run_leases_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_study_run_leases
    ADD CONSTRAINT project_study_run_leases_run_id_fkey FOREIGN KEY (run_id) REFERENCES project_study_runs(id) ON DELETE CASCADE;


--
-- Name: project_study_runs project_study_runs_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_study_runs
    ADD CONSTRAINT project_study_runs_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: project_study_runs project_study_runs_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_study_runs
    ADD CONSTRAINT project_study_runs_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth_accounts(id);


--
-- Name: project_study_runs project_study_runs_study_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_study_runs
    ADD CONSTRAINT project_study_runs_study_id_project_id_fkey FOREIGN KEY (study_id, project_id) REFERENCES project_studies(id, project_id);


--
-- Name: project_study_runs project_study_runs_study_id_study_revision_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_study_runs
    ADD CONSTRAINT project_study_runs_study_id_study_revision_fkey FOREIGN KEY (study_id, study_revision) REFERENCES project_study_versions(study_id, revision);


--
-- Name: project_study_versions project_study_versions_author_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_study_versions
    ADD CONSTRAINT project_study_versions_author_account_id_fkey FOREIGN KEY (author_account_id) REFERENCES auth_accounts(id);


--
-- Name: project_study_versions project_study_versions_study_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY project_study_versions
    ADD CONSTRAINT project_study_versions_study_id_project_id_fkey FOREIGN KEY (study_id, project_id) REFERENCES project_studies(id, project_id) ON DELETE CASCADE;


--
-- Name: projects projects_owner_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY projects
    ADD CONSTRAINT projects_owner_account_id_fkey FOREIGN KEY (owner_account_id) REFERENCES auth_accounts(id) ON DELETE RESTRICT;


--
-- Name: scheme_components scheme_component_model_type_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY scheme_components
    ADD CONSTRAINT scheme_component_model_type_fk FOREIGN KEY (equipment_model_id, component_type_id) REFERENCES equipment_models(id, component_type_id);


--
-- Name: scheme_component_params scheme_component_params_scheme_component_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY scheme_component_params
    ADD CONSTRAINT scheme_component_params_scheme_component_id_fkey FOREIGN KEY (scheme_component_id) REFERENCES scheme_components(id) ON DELETE CASCADE;


--
-- Name: scheme_components scheme_components_component_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY scheme_components
    ADD CONSTRAINT scheme_components_component_type_id_fkey FOREIGN KEY (component_type_id) REFERENCES component_types(id);


--
-- Name: scheme_components scheme_components_project_passport_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY scheme_components
    ADD CONSTRAINT scheme_components_project_passport_version_id_fkey FOREIGN KEY (project_passport_version_id) REFERENCES project_passports(id);


--
-- Name: scheme_components scheme_components_scheme_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY scheme_components
    ADD CONSTRAINT scheme_components_scheme_id_fkey FOREIGN KEY (scheme_id) REFERENCES circuit_schemes(id) ON DELETE CASCADE;


--
-- Name: scheme_connections scheme_connections_from_component_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY scheme_connections
    ADD CONSTRAINT scheme_connections_from_component_id_fkey FOREIGN KEY (from_component_id) REFERENCES scheme_components(id) ON DELETE CASCADE;


--
-- Name: scheme_connections scheme_connections_scheme_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY scheme_connections
    ADD CONSTRAINT scheme_connections_scheme_id_fkey FOREIGN KEY (scheme_id) REFERENCES circuit_schemes(id) ON DELETE CASCADE;


--
-- Name: scheme_connections scheme_connections_to_component_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY scheme_connections
    ADD CONSTRAINT scheme_connections_to_component_id_fkey FOREIGN KEY (to_component_id) REFERENCES scheme_components(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--



-- Initial equipment catalog. No saved electrical schemes or accounts.
--
-- PostgreSQL database dump
--


-- Dumped from database version 15.19
-- Dumped by pg_dump version 15.19


--
-- Data for Name: auth_accounts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: auth_local_credentials; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: auth_sessions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: projects; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: circuit_schemes; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: component_types; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO component_types (id, code, name, category, description) VALUES (1, 'generator', 'Генератор', 'source', 'Синхронный генератор');
INSERT INTO component_types (id, code, name, category, description) VALUES (2, 'transformer', 'Трансформатор', 'transform', 'Двухобмоточный трансформатор');
INSERT INTO component_types (id, code, name, category, description) VALUES (3, 'transformer_3w', 'Трёхобмоточный трансформатор', 'transform', 'Трёхобмоточный трансформатор');
INSERT INTO component_types (id, code, name, category, description) VALUES (4, 'autotransformer', 'Автотрансформатор', 'transform', 'Автотрансформатор');
INSERT INTO component_types (id, code, name, category, description) VALUES (5, 'transmission_line', 'Линия электропередачи', 'line', 'Воздушная или кабельная линия');
INSERT INTO component_types (id, code, name, category, description) VALUES (6, 'breaker', 'Выключатель', 'switch', 'Силовой выключатель');
INSERT INTO component_types (id, code, name, category, description) VALUES (7, 'disconnector', 'Разъединитель', 'switch', 'Разъединитель');
INSERT INTO component_types (id, code, name, category, description) VALUES (8, 'grounding_switch', 'Заземлитель', 'switch', 'Заземляющий разъединитель');
INSERT INTO component_types (id, code, name, category, description) VALUES (9, 'load', 'Нагрузка', 'load', 'Потребитель активной и реактивной мощности');
INSERT INTO component_types (id, code, name, category, description) VALUES (10, 'ground', 'Заземление', 'ground', 'Узел заземления');
INSERT INTO component_types (id, code, name, category, description) VALUES (11, 'busbar', 'Сборная шина', 'bus', 'Сборная шина с несколькими присоединениями');
INSERT INTO component_types (id, code, name, category, description) VALUES (12, 'capacitor', 'Батарея конденсаторов', 'compensation', 'Продольная или поперечная компенсация');
INSERT INTO component_types (id, code, name, category, description) VALUES (13, 'reactor', 'Реактор', 'compensation', 'Шунтирующий реактор');


--
-- Data for Name: component_params_template; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (1, 1, 'voltage_nom', 'Номинальное напряжение', 'number', '110.0', 'кВ');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (2, 1, 'power_nom', 'Номинальная мощность', 'number', '100.0', 'МВА');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (3, 1, 'r', 'Активное сопротивление', 'number', '0.0', 'Ом');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (4, 1, 'x', 'Индуктивное сопротивление', 'number', '0.2', 'Ом');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (5, 1, 'e', 'ЭДС', 'number', '115.0', 'кВ');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (6, 1, 'angle', 'Угол ЭДС', 'number', '0.0', 'град');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (7, 2, 'power_nom', 'Номинальная мощность', 'number', '25.0', 'МВА');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (8, 2, 'voltage_hv', 'Напряжение ВН', 'number', '110.0', 'кВ');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (9, 2, 'voltage_lv', 'Напряжение НН', 'number', '10.5', 'кВ');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (10, 2, 'p_kz', 'Потери КЗ', 'number', '0.12', 'МВт');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (11, 2, 'u_kz', 'Напряжение КЗ', 'number', '10.5', '%');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (12, 2, 'p_xx', 'Потери ХХ', 'number', '0.025', 'МВт');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (13, 2, 'i_xx', 'Ток ХХ', 'number', '0.7', '%');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (14, 5, 'length', 'Длина', 'number', '50.0', 'км');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (15, 5, 'r0', 'Удельное активное сопротивление', 'number', '0.12', 'Ом/км');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (16, 5, 'x0', 'Удельное индуктивное сопротивление', 'number', '0.4', 'Ом/км');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (17, 5, 'b0', 'Удельная ёмкостная проводимость', 'number', '0.0000028', 'См/км');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (18, 5, 'g0', 'Удельная активная проводимость', 'number', '0.0', 'См/км');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (19, 5, 'circuits', 'Число цепей', 'number', '1', '');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (20, 5, 'r_aa', 'R фазы A', 'number', '0.12', 'Ом/км');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (21, 5, 'x_aa', 'X фазы A', 'number', '0.4', 'Ом/км');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (22, 5, 'r_bb', 'R фазы B', 'number', '0.12', 'Ом/км');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (23, 5, 'x_bb', 'X фазы B', 'number', '0.4', 'Ом/км');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (24, 5, 'r_cc', 'R фазы C', 'number', '0.12', 'Ом/км');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (25, 5, 'x_cc', 'X фазы C', 'number', '0.4', 'Ом/км');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (26, 5, 'r_ab', 'Взаимное R A-B', 'number', '0.012', 'Ом/км');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (27, 5, 'x_ab', 'Взаимное X A-B', 'number', '0.04', 'Ом/км');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (28, 5, 'r_bc', 'Взаимное R B-C', 'number', '0.012', 'Ом/км');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (29, 5, 'x_bc', 'Взаимное X B-C', 'number', '0.04', 'Ом/км');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (30, 5, 'r_ca', 'Взаимное R C-A', 'number', '0.012', 'Ом/км');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (31, 5, 'x_ca', 'Взаимное X C-A', 'number', '0.04', 'Ом/км');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (32, 9, 'p', 'Активная мощность', 'number', '50.0', 'МВт');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (33, 9, 'q', 'Реактивная мощность', 'number', '20.0', 'Мвар');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (34, 9, 'voltage_nom', 'Номинальное напряжение', 'number', '110.0', 'кВ');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (35, 9, 'p_a', 'P фазы A', 'number', '16.667', 'МВт');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (36, 9, 'q_a', 'Q фазы A', 'number', '6.667', 'Мвар');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (37, 9, 'p_b', 'P фазы B', 'number', '16.667', 'МВт');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (38, 9, 'q_b', 'Q фазы B', 'number', '6.667', 'Мвар');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (39, 9, 'p_c', 'P фазы C', 'number', '16.667', 'МВт');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (40, 9, 'q_c', 'Q фазы C', 'number', '6.667', 'Мвар');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (41, 6, 'voltage_nom', 'Номинальное напряжение', 'number', '110.0', 'кВ');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (42, 6, 'current_nom', 'Номинальный ток', 'number', '1250.0', 'А');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (43, 6, 'status', 'Статус (включен)', 'boolean', 'true', '');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (44, 7, 'voltage_nom', 'Номинальное напряжение', 'number', '110.0', 'кВ');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (45, 7, 'current_nom', 'Номинальный ток', 'number', '1000.0', 'А');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (46, 7, 'status', 'Статус (включен)', 'boolean', 'true', '');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (47, 11, 'voltage_nom', 'Номинальное напряжение', 'number', '110.0', 'кВ');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (48, 11, 'current_nom', 'Номинальный ток', 'number', '2000.0', 'А');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (49, 1, 'p', 'Активная мощность', 'number', '100.0', 'МВт');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (50, 3, 'power_nom', 'Номинальная мощность', 'number', '25.0', 'МВА');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (51, 3, 'voltage_hv', 'Напряжение ВН', 'number', '115.0', 'кВ');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (52, 3, 'voltage_mv', 'Напряжение СН', 'number', '38.5', 'кВ');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (53, 3, 'voltage_lv', 'Напряжение НН', 'number', '11.0', 'кВ');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (54, 3, 'p_kz_hv_mv', 'Потери КЗ ВН-СН', 'number', '0.10', 'МВт');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (55, 3, 'p_kz_hv_lv', 'Потери КЗ ВН-НН', 'number', '0.10', 'МВт');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (56, 3, 'p_kz_mv_lv', 'Потери КЗ СН-НН', 'number', '0.10', 'МВт');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (57, 3, 'u_kz_hv_mv', 'Напряжение КЗ ВН-СН', 'number', '10.5', '%');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (58, 3, 'u_kz_hv_lv', 'Напряжение КЗ ВН-НН', 'number', '17.0', '%');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (59, 3, 'u_kz_mv_lv', 'Напряжение КЗ СН-НН', 'number', '6.5', '%');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (60, 3, 'p_xx', 'Потери ХХ', 'number', '0.025', 'МВт');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (61, 3, 'i_xx', 'Ток ХХ', 'number', '0.7', '%');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (62, 4, 'power_nom', 'Номинальная мощность', 'number', '125.0', 'МВА');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (63, 4, 'voltage_hv', 'Напряжение ВН', 'number', '230.0', 'кВ');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (64, 4, 'voltage_mv', 'Напряжение СН', 'number', '121.0', 'кВ');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (65, 4, 'voltage_lv', 'Напряжение НН', 'number', '11.0', 'кВ');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (66, 4, 'p_kz', 'Потери КЗ', 'number', '0.30', 'МВт');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (67, 4, 'u_kz', 'Напряжение КЗ', 'number', '11.0', '%');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (68, 4, 'p_xx', 'Потери ХХ', 'number', '0.050', 'МВт');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (69, 4, 'i_xx', 'Ток ХХ', 'number', '0.3', '%');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (70, 12, 'voltage_nom', 'Номинальное напряжение', 'number', '10.5', 'кВ');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (71, 12, 'q_nom', 'Номинальная мощность', 'number', '30.0', 'Мвар');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (72, 12, 'c', 'Ёмкость', 'number', '900.0', 'мкФ');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (73, 13, 'voltage_nom', 'Номинальное напряжение', 'number', '110.0', 'кВ');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (74, 13, 'q_nom', 'Номинальная мощность', 'number', '25.0', 'Мвар');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (75, 13, 'l', 'Индуктивность', 'number', '0.5', 'Гн');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (76, 8, 'voltage_nom', 'Номинальное напряжение', 'number', '110.0', 'кВ');
INSERT INTO component_params_template (id, component_type_id, param_key, param_name, param_type, default_value, unit) VALUES (77, 8, 'status', 'Статус (заземлён)', 'boolean', 'false', '');


--
-- Data for Name: component_type_ports; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (1, 'bottom', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (1, 'top', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (2, 'b', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (2, 'a', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (2, 'right', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (2, 'left', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (2, 'bottom', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (2, 'top', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (3, 'bottom', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (3, 'right', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (3, 'left', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (3, 'br', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (3, 'bl', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (3, 'top', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (4, 'b', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (4, 'a', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (4, 'right', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (4, 'left', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (4, 'bottom', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (4, 'top', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (5, 'bottom', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (5, 'top', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (5, 'right', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (5, 'left', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (6, 'bottom', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (6, 'top', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (7, 'bottom', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (7, 'top', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (8, 'top', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (9, 'top', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (10, 'top', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (11, 'right', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (11, 'left', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (12, 'top', 'electrical-ac');
INSERT INTO component_type_ports (component_type_id, port_name, domain) VALUES (13, 'top', 'electrical-ac');


--
-- Data for Name: connection_commands; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: equipment_models; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (1, 1, 'ТВФ-63-2У3', 'Элсиб', 'Турбогенератор 63 МВт, 10.5 кВ, cosφ=0.8');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (2, 1, 'ТВФ-120-2У3', 'Элсиб', 'Турбогенератор 120 МВт, 10.5 кВ, cosφ=0.8');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (3, 1, 'ТВВ-200-2АУ3', 'Электросила', 'Турбогенератор 200 МВт, 15.75 кВ, cosφ=0.85');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (4, 1, 'ТВВ-320-2У3', 'Электросила', 'Турбогенератор 320 МВт, 20 кВ, cosφ=0.85');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (5, 1, 'ТВВ-500-2У3', 'Электросила', 'Турбогенератор 500 МВт, 20 кВ, cosφ=0.85');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (6, 1, 'ТВВ-800-2У3', 'Электросила', 'Турбогенератор 800 МВт, 24 кВ, cosφ=0.9');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (7, 1, 'ТВВ-1000-4У3', 'Электросила', 'Турбогенератор 1000 МВт, 24 кВ, cosφ=0.9');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (8, 1, 'СВ-850/190-24', 'Уралэлектротяжмаш', 'Гидрогенератор 71 МВт, 10.5 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (9, 1, 'СВ-1500/200-88', 'Уралэлектротяжмаш', 'Гидрогенератор 150 МВт, 15.75 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (10, 2, 'ТМ-1000/10', 'МЭТЗ', 'Трансформатор 1 МВА, 10/0.4 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (11, 2, 'ТМ-2500/10', 'МЭТЗ', 'Трансформатор 2.5 МВА, 10/0.4 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (12, 2, 'ТД-16000/35', 'Укртрансформатор', 'Трансформатор 16 МВА, 35/11 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (13, 2, 'ТДН-16000/110', 'АТМ', 'Трансформатор 16 МВА, 115/11 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (14, 2, 'ТДН-25000/110', 'АТМ', 'Трансформатор 25 МВА, 115/11 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (15, 2, 'ТДН-40000/110', 'АТМ', 'Трансформатор 40 МВА, 115/11 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (16, 2, 'ТРДН-40000/110', 'АТМ', 'Трансформатор 40 МВА, 115/10.5-10.5 кВ (расщеплённая обмотка)');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (17, 2, 'ТДН-63000/110', 'АТМ', 'Трансформатор 63 МВА, 115/11 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (18, 2, 'ТДЦ-125000/110', 'АТМ', 'Трансформатор 125 МВА, 115/10.5 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (19, 2, 'ТДЦ-200000/110', 'АТМ', 'Трансформатор 200 МВА, 115/15.75 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (20, 2, 'ТЦ-630000/500', 'АТМ', 'Трансформатор 630 МВА, 525/20 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (21, 3, 'ТДТН-25000/110', 'АТМ', 'Трёхобмоточный 25 МВА, 115/38.5/11 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (22, 3, 'ТДТН-40000/110', 'АТМ', 'Трёхобмоточный 40 МВА, 115/38.5/11 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (23, 3, 'ТДТН-63000/110', 'АТМ', 'Трёхобмоточный 63 МВА, 115/38.5/11 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (24, 4, 'АТДЦТН-125000/220/110', 'АТМ', 'Автотрансформатор 125 МВА, 230/121 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (25, 4, 'АТДЦТН-200000/220/110', 'АТМ', 'Автотрансформатор 200 МВА, 230/121 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (26, 4, 'АТДЦТН-250000/330/110', 'АТМ', 'Автотрансформатор 250 МВА, 330/121 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (27, 4, 'АТДЦТН-500000/500/220', 'АТМ', 'Автотрансформатор 500 МВА, 525/242 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (28, 4, 'АОДЦТН-167000/500/220', 'АТМ', 'Автотрансформатор 167 МВА (одна фаза), 500/220 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (29, 5, 'АС-70/11', 'Энергокабель', 'Провод 70 мм², 0.428 Ом/км, 110 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (30, 5, 'АС-95/16', 'Энергокабель', 'Провод 95 мм², 0.306 Ом/км, 110 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (31, 5, 'АС-120/19', 'Энергокабель', 'Провод 120 мм², 0.249 Ом/км, 110 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (32, 5, 'АС-150/24', 'Энергокабель', 'Провод 150 мм², 0.198 Ом/км, 110 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (33, 5, 'АС-185/29', 'Энергокабель', 'Провод 185 мм², 0.162 Ом/км, 110-220 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (34, 5, 'АС-240/32', 'Энергокабель', 'Провод 240 мм², 0.120 Ом/км, 110-220 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (35, 5, 'АС-300/39', 'Энергокабель', 'Провод 300 мм², 0.096 Ом/км, 220 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (36, 5, 'АС-400/51', 'Энергокабель', 'Провод 400 мм², 0.075 Ом/км, 220-330 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (37, 5, 'АС-500/64', 'Энергокабель', 'Провод 500 мм², 0.060 Ом/км, 330-500 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (38, 5, '2хАС-300/39', 'Энергокабель', '2 провода 300 мм² в фазе, 0.048 Ом/км, 330 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (39, 5, '2хАС-400/51', 'Энергокабель', '2 провода 400 мм² в фазе, 0.037 Ом/км, 330-500 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (40, 5, '3хАС-400/51', 'Энергокабель', '3 провода 400 мм² в фазе, 0.025 Ом/км, 500 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (41, 5, '3хАС-500/64', 'Энергокабель', '3 провода 500 мм² в фазе, 0.020 Ом/км, 500-750 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (42, 5, 'Кабель СБ-3х240', 'Энергокабель', 'Силовой кабель 3х240 мм², 10 кВ, 0.129 Ом/км');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (43, 5, 'Кабель ААБ-3х150', 'Энергокабель', 'Силовой кабель 3х150 мм², 10 кВ, 0.206 Ом/км');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (44, 9, 'Промышленная нагрузка', '—', 'Типовая промышленная нагрузка, P=50 МВт, Q=25 Мвар');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (45, 9, 'Коммунально-бытовая нагрузка', '—', 'Типовая городская нагрузка, P=10 МВт, Q=4 Мвар');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (46, 9, 'Смешанная нагрузка', '—', 'Промышленно-бытовая смешанная, P=30 МВт, Q=15 Мвар');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (47, 9, 'Тяговая нагрузка', '—', 'Тяговая подстанция ж/д, P=20 МВт, Q=10 Мвар');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (48, 9, 'Сельскохозяйственная нагрузка', '—', 'Сельская нагрузка, P=5 МВт, Q=2 Мвар');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (49, 9, 'Нефтедобыча (ЭЦН)', '—', 'Нагрузка нефтедобычи, P=15 МВт, Q=7.5 Мвар');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (50, 12, 'БСК-10-6.3', 'Электрокерамика', 'Батарея 6.3 Мвар, 10.5 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (51, 12, 'БСК-10-12.5', 'Электрокерамика', 'Батарея 12.5 Мвар, 10.5 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (52, 12, 'БСК-35-25', 'Электрокерамика', 'Батарея 25 Мвар, 35 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (53, 12, 'БСК-110-50', 'Электрокерамика', 'Батарея 50 Мвар, 110 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (54, 12, 'БСК-220-100', 'Электрокерамика', 'Батарея 100 Мвар, 220 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (55, 12, 'УКРМ-0.4-400', 'Электрокерамика', 'Установка компенсации 400 квар, 0.4 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (56, 13, 'РДС-110-25', 'Электрокерамика', 'Шунтирующий реактор 25 Мвар, 110 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (57, 13, 'РДС-110-50', 'Электрокерамика', 'Шунтирующий реактор 50 Мвар, 110 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (58, 13, 'РДС-220-50', 'Электрокерамика', 'Шунтирующий реактор 50 Мвар, 220 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (59, 13, 'РДС-220-100', 'Электрокерамика', 'Шунтирующий реактор 100 Мвар, 220 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (60, 13, 'РДС-330-100', 'Электрокерамика', 'Шунтирующий реактор 100 Мвар, 330 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (61, 13, 'РДС-500-150', 'Электрокерамика', 'Шунтирующий реактор 150 Мвар, 500 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (62, 13, 'РДС-750-200', 'Электрокерамика', 'Шунтирующий реактор 200 Мвар, 750 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (63, 6, 'ВМТ-110Б-25/1250', 'Электроаппарат', 'Масляный выключатель 110 кВ, 1250 А, 25 кА');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (64, 6, 'ВГБ-110-40/2500', 'Электроаппарат', 'Элегазовый выключатель 110 кВ, 2500 А, 40 кА');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (65, 6, 'ВГБ-220-40/2500', 'Электроаппарат', 'Элегазовый выключатель 220 кВ, 2500 А, 40 кА');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (66, 6, 'ВВБ-220-31.5/2000', 'Электроаппарат', 'Воздушный выключатель 220 кВ, 2000 А, 31.5 кА');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (67, 6, 'ВЭБ-330-40/2500', 'Электроаппарат', 'Элегазовый выключатель 330 кВ, 2500 А, 40 кА');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (68, 6, 'ВЭБ-500-40/3150', 'Электроаппарат', 'Элегазовый выключатель 500 кВ, 3150 А, 40 кА');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (69, 6, 'ВЭБ-750-40/3150', 'Электроаппарат', 'Элегазовый выключатель 750 кВ, 3150 А, 40 кА');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (70, 6, 'ВВЭ-10-20/1000', 'Электроаппарат', 'Вакуумный выключатель 10 кВ, 1000 А, 20 кА');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (71, 6, 'ВВЭ-10-31.5/1600', 'Электроаппарат', 'Вакуумный выключатель 10 кВ, 1600 А, 31.5 кА');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (72, 6, 'ВВЭ-35-25/1250', 'Электроаппарат', 'Вакуумный выключатель 35 кВ, 1250 А, 25 кА');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (73, 7, 'РНДЗ-110/1000', 'Электроаппарат', 'Разъединитель 110 кВ, 1000 А');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (74, 7, 'РНДЗ-110/2000', 'Электроаппарат', 'Разъединитель 110 кВ, 2000 А');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (75, 7, 'РНДЗ-220/1000', 'Электроаппарат', 'Разъединитель 220 кВ, 1000 А');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (76, 7, 'РНДЗ-220/2000', 'Электроаппарат', 'Разъединитель 220 кВ, 2000 А');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (77, 7, 'РНДЗ-330/2000', 'Электроаппарат', 'Разъединитель 330 кВ, 2000 А');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (78, 7, 'РНДЗ-500/3150', 'Электроаппарат', 'Разъединитель 500 кВ, 3150 А');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (79, 7, 'РНДЗ-750/3150', 'Электроаппарат', 'Разъединитель 750 кВ, 3150 А');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (80, 7, 'РВ-10/1000', 'Электроаппарат', 'Разъединитель 10 кВ, 1000 А');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (81, 11, 'Шины 10 кВ, 2000 А', '—', 'Сборные шины РУ-10 кВ, 2000 А');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (82, 11, 'Шины 35 кВ, 1000 А', '—', 'Сборные шины РУ-35 кВ, 1000 А');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (83, 11, 'Шины 110 кВ, 2000 А', '—', 'Сборные шины РУ-110 кВ, 2000 А');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (84, 11, 'Шины 220 кВ, 2500 А', '—', 'Сборные шины РУ-220 кВ, 2500 А');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (85, 11, 'Шины 330 кВ, 3150 А', '—', 'Сборные шины РУ-330 кВ, 3150 А');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (86, 11, 'Шины 500 кВ, 4000 А', '—', 'Сборные шины РУ-500 кВ, 4000 А');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (87, 11, 'Шины 750 кВ, 5000 А', '—', 'Сборные шины РУ-750 кВ, 5000 А');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (88, 8, 'ЗОН-110', 'Электроаппарат', 'Заземлитель 110 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (89, 8, 'ЗОН-220', 'Электроаппарат', 'Заземлитель 220 кВ');
INSERT INTO equipment_models (id, component_type_id, model_name, manufacturer, description) VALUES (90, 8, 'ЗОН-500', 'Электроаппарат', 'Заземлитель 500 кВ');


--
-- Data for Name: equipment_model_params; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (1, 1, 'p', '63.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (2, 1, 'e', '11.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (3, 1, 'x', '0.153');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (4, 1, 'power_nom', '78.75');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (5, 1, 'voltage_nom', '10.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (6, 2, 'p', '120.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (7, 2, 'e', '11.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (8, 2, 'x', '0.192');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (9, 2, 'power_nom', '150.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (10, 2, 'voltage_nom', '10.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (11, 3, 'p', '200.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (12, 3, 'e', '16.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (13, 3, 'x', '0.185');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (14, 3, 'power_nom', '235.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (15, 3, 'voltage_nom', '15.75');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (16, 4, 'p', '320.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (17, 4, 'e', '21.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (18, 4, 'x', '0.180');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (19, 4, 'power_nom', '376.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (20, 4, 'voltage_nom', '20.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (21, 5, 'p', '500.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (22, 5, 'e', '21.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (23, 5, 'x', '0.175');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (24, 5, 'power_nom', '588.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (25, 5, 'voltage_nom', '20.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (26, 6, 'p', '800.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (27, 6, 'e', '25.2');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (28, 6, 'x', '0.170');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (29, 6, 'power_nom', '889.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (30, 6, 'voltage_nom', '24.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (31, 7, 'p', '1000.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (32, 7, 'e', '25.2');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (33, 7, 'x', '0.165');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (34, 7, 'power_nom', '1111.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (35, 7, 'voltage_nom', '24.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (36, 8, 'p', '71.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (37, 8, 'e', '11.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (38, 8, 'x', '0.210');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (39, 8, 'power_nom', '84.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (40, 8, 'voltage_nom', '10.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (41, 9, 'p', '150.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (42, 9, 'e', '16.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (43, 9, 'x', '0.200');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (44, 9, 'power_nom', '176.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (45, 9, 'voltage_nom', '15.75');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (46, 10, 'i_xx', '1.4');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (47, 10, 'p_xx', '0.002');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (48, 10, 'u_kz', '5.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (49, 10, 'p_kz', '0.012');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (50, 10, 'voltage_lv', '0.4');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (51, 10, 'voltage_hv', '10.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (52, 10, 'power_nom', '1.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (53, 11, 'i_xx', '1.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (54, 11, 'p_xx', '0.004');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (55, 11, 'u_kz', '5.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (56, 11, 'p_kz', '0.025');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (57, 11, 'voltage_lv', '0.4');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (58, 11, 'voltage_hv', '10.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (59, 11, 'power_nom', '2.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (60, 12, 'i_xx', '0.8');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (61, 12, 'p_xx', '0.021');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (62, 12, 'u_kz', '8.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (63, 12, 'p_kz', '0.090');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (64, 12, 'voltage_lv', '11.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (65, 12, 'voltage_hv', '35.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (66, 12, 'power_nom', '16.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (67, 13, 'i_xx', '0.7');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (68, 13, 'p_xx', '0.018');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (69, 13, 'u_kz', '10.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (70, 13, 'p_kz', '0.085');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (71, 13, 'voltage_lv', '11.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (72, 13, 'voltage_hv', '115.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (73, 13, 'power_nom', '16.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (74, 14, 'i_xx', '0.65');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (75, 14, 'p_xx', '0.025');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (76, 14, 'u_kz', '10.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (77, 14, 'p_kz', '0.120');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (78, 14, 'voltage_lv', '11.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (79, 14, 'voltage_hv', '115.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (80, 14, 'power_nom', '25.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (81, 15, 'i_xx', '0.55');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (82, 15, 'p_xx', '0.034');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (83, 15, 'u_kz', '10.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (84, 15, 'p_kz', '0.170');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (85, 15, 'voltage_lv', '11.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (86, 15, 'voltage_hv', '115.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (87, 15, 'power_nom', '40.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (88, 16, 'i_xx', '0.55');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (89, 16, 'p_xx', '0.034');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (90, 16, 'u_kz', '10.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (91, 16, 'p_kz', '0.170');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (92, 16, 'voltage_lv', '10.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (93, 16, 'voltage_hv', '115.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (94, 16, 'power_nom', '40.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (95, 17, 'i_xx', '0.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (96, 17, 'p_xx', '0.050');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (97, 17, 'u_kz', '10.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (98, 17, 'p_kz', '0.260');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (99, 17, 'voltage_lv', '11.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (100, 17, 'voltage_hv', '115.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (101, 17, 'power_nom', '63.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (102, 18, 'i_xx', '0.4');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (103, 18, 'p_xx', '0.080');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (104, 18, 'u_kz', '10.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (105, 18, 'p_kz', '0.400');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (106, 18, 'voltage_lv', '10.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (107, 18, 'voltage_hv', '115.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (108, 18, 'power_nom', '125.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (109, 19, 'i_xx', '0.35');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (110, 19, 'p_xx', '0.120');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (111, 19, 'u_kz', '11.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (112, 19, 'p_kz', '0.550');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (113, 19, 'voltage_lv', '15.75');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (114, 19, 'voltage_hv', '115.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (115, 19, 'power_nom', '200.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (116, 20, 'i_xx', '0.3');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (117, 20, 'p_xx', '0.250');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (118, 20, 'u_kz', '14.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (119, 20, 'p_kz', '1.200');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (120, 20, 'voltage_lv', '20.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (121, 20, 'voltage_hv', '525.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (122, 20, 'power_nom', '630.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (123, 21, 'i_xx', '0.7');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (124, 21, 'p_xx', '0.025');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (125, 21, 'u_kz_mv_lv', '6.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (126, 21, 'u_kz_hv_lv', '17.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (127, 21, 'u_kz_hv_mv', '10.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (128, 21, 'p_kz_mv_lv', '0.110');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (129, 21, 'p_kz_hv_lv', '0.115');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (130, 21, 'p_kz_hv_mv', '0.120');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (131, 21, 'voltage_lv', '11.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (132, 21, 'voltage_mv', '38.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (133, 21, 'voltage_hv', '115.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (134, 21, 'power_nom', '25.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (135, 22, 'i_xx', '0.55');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (136, 22, 'p_xx', '0.034');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (137, 22, 'u_kz_mv_lv', '6.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (138, 22, 'u_kz_hv_lv', '17.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (139, 22, 'u_kz_hv_mv', '10.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (140, 22, 'p_kz_mv_lv', '0.160');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (141, 22, 'p_kz_hv_lv', '0.165');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (142, 22, 'p_kz_hv_mv', '0.170');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (143, 22, 'voltage_lv', '11.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (144, 22, 'voltage_mv', '38.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (145, 22, 'voltage_hv', '115.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (146, 22, 'power_nom', '40.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (147, 23, 'i_xx', '0.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (148, 23, 'p_xx', '0.050');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (149, 23, 'u_kz_mv_lv', '6.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (150, 23, 'u_kz_hv_lv', '17.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (151, 23, 'u_kz_hv_mv', '10.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (152, 23, 'p_kz_mv_lv', '0.240');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (153, 23, 'p_kz_hv_lv', '0.250');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (154, 23, 'p_kz_hv_mv', '0.260');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (155, 23, 'voltage_lv', '11.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (156, 23, 'voltage_mv', '38.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (157, 23, 'voltage_hv', '115.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (158, 23, 'power_nom', '63.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (159, 24, 'i_xx', '0.3');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (160, 24, 'p_xx', '0.050');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (161, 24, 'u_kz', '11.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (162, 24, 'p_kz', '0.300');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (163, 24, 'voltage_lv', '11.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (164, 24, 'voltage_mv', '121.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (165, 24, 'voltage_hv', '230.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (166, 24, 'power_nom', '125.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (167, 25, 'i_xx', '0.25');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (168, 25, 'p_xx', '0.080');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (169, 25, 'u_kz', '11.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (170, 25, 'p_kz', '0.420');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (171, 25, 'voltage_lv', '11.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (172, 25, 'voltage_mv', '121.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (173, 25, 'voltage_hv', '230.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (174, 25, 'power_nom', '200.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (175, 26, 'i_xx', '0.2');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (176, 26, 'p_xx', '0.100');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (177, 26, 'u_kz', '11.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (178, 26, 'p_kz', '0.500');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (179, 26, 'voltage_lv', '11.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (180, 26, 'voltage_mv', '121.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (181, 26, 'voltage_hv', '330.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (182, 26, 'power_nom', '250.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (183, 27, 'i_xx', '0.15');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (184, 27, 'p_xx', '0.150');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (185, 27, 'u_kz', '12.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (186, 27, 'p_kz', '0.700');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (187, 27, 'voltage_lv', '15.75');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (188, 27, 'voltage_mv', '242.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (189, 27, 'voltage_hv', '525.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (190, 27, 'power_nom', '500.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (191, 28, 'i_xx', '0.15');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (192, 28, 'p_xx', '0.060');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (193, 28, 'u_kz', '12.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (194, 28, 'p_kz', '0.250');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (195, 28, 'voltage_lv', '15.75');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (196, 28, 'voltage_mv', '242.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (197, 28, 'voltage_hv', '525.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (198, 28, 'power_nom', '167.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (199, 29, 'circuits', '1');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (200, 29, 'b0', '0.00000255');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (201, 29, 'x0', '0.444');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (202, 29, 'r0', '0.428');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (203, 30, 'circuits', '1');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (204, 30, 'b0', '0.00000261');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (205, 30, 'x0', '0.434');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (206, 30, 'r0', '0.306');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (207, 31, 'circuits', '1');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (208, 31, 'b0', '0.00000266');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (209, 31, 'x0', '0.427');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (210, 31, 'r0', '0.249');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (211, 32, 'circuits', '1');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (212, 32, 'b0', '0.00000270');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (213, 32, 'x0', '0.420');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (214, 32, 'r0', '0.198');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (215, 33, 'circuits', '1');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (216, 33, 'b0', '0.00000275');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (217, 33, 'x0', '0.413');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (218, 33, 'r0', '0.162');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (219, 34, 'circuits', '1');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (220, 34, 'b0', '0.00000281');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (221, 34, 'x0', '0.405');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (222, 34, 'r0', '0.120');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (223, 35, 'circuits', '1');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (224, 35, 'b0', '0.00000286');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (225, 35, 'x0', '0.398');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (226, 35, 'r0', '0.096');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (227, 36, 'circuits', '1');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (228, 36, 'b0', '0.00000291');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (229, 36, 'x0', '0.391');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (230, 36, 'r0', '0.075');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (231, 37, 'circuits', '1');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (232, 37, 'b0', '0.00000296');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (233, 37, 'x0', '0.385');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (234, 37, 'r0', '0.060');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (235, 38, 'circuits', '1');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (236, 38, 'b0', '0.00000330');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (237, 38, 'x0', '0.321');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (238, 38, 'r0', '0.048');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (239, 39, 'circuits', '1');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (240, 39, 'b0', '0.00000340');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (241, 39, 'x0', '0.315');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (242, 39, 'r0', '0.037');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (243, 40, 'circuits', '1');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (244, 40, 'b0', '0.00000355');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (245, 40, 'x0', '0.302');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (246, 40, 'r0', '0.025');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (247, 41, 'circuits', '1');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (248, 41, 'b0', '0.00000365');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (249, 41, 'x0', '0.298');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (250, 41, 'r0', '0.020');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (251, 42, 'circuits', '1');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (252, 42, 'b0', '0.00000110');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (253, 42, 'x0', '0.071');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (254, 42, 'r0', '0.129');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (255, 43, 'circuits', '1');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (256, 43, 'b0', '0.00000105');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (257, 43, 'x0', '0.074');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (258, 43, 'r0', '0.206');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (259, 44, 'voltage_nom', '110.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (260, 44, 'q', '25.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (261, 44, 'p', '50.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (262, 45, 'voltage_nom', '10.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (263, 45, 'q', '4.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (264, 45, 'p', '10.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (265, 46, 'voltage_nom', '110.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (266, 46, 'q', '15.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (267, 46, 'p', '30.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (268, 47, 'voltage_nom', '110.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (269, 47, 'q', '10.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (270, 47, 'p', '20.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (271, 48, 'voltage_nom', '10.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (272, 48, 'q', '2.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (273, 48, 'p', '5.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (274, 49, 'voltage_nom', '35.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (275, 49, 'q', '7.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (276, 49, 'p', '15.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (277, 50, 'c', '182.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (278, 50, 'q_nom', '6.3');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (279, 50, 'voltage_nom', '10.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (280, 51, 'c', '361.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (281, 51, 'q_nom', '12.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (282, 51, 'voltage_nom', '10.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (283, 52, 'c', '6.5');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (284, 52, 'q_nom', '25.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (285, 52, 'voltage_nom', '35.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (286, 53, 'c', '1.32');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (287, 53, 'q_nom', '50.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (288, 53, 'voltage_nom', '110.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (289, 54, 'c', '0.66');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (290, 54, 'q_nom', '100.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (291, 54, 'voltage_nom', '220.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (292, 55, 'c', '7960.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (293, 55, 'q_nom', '0.4');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (294, 55, 'voltage_nom', '0.4');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (295, 56, 'l', '0.462');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (296, 56, 'q_nom', '25.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (297, 56, 'voltage_nom', '110.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (298, 57, 'l', '0.231');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (299, 57, 'q_nom', '50.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (300, 57, 'voltage_nom', '110.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (301, 58, 'l', '0.924');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (302, 58, 'q_nom', '50.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (303, 58, 'voltage_nom', '220.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (304, 59, 'l', '0.462');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (305, 59, 'q_nom', '100.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (306, 59, 'voltage_nom', '220.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (307, 60, 'l', '1.04');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (308, 60, 'q_nom', '100.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (309, 60, 'voltage_nom', '330.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (310, 61, 'l', '1.68');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (311, 61, 'q_nom', '150.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (312, 61, 'voltage_nom', '500.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (313, 62, 'l', '2.81');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (314, 62, 'q_nom', '200.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (315, 62, 'voltage_nom', '750.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (316, 63, 'status', 'true');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (317, 63, 'current_nom', '1250.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (318, 63, 'voltage_nom', '110.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (319, 64, 'status', 'true');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (320, 64, 'current_nom', '2500.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (321, 64, 'voltage_nom', '110.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (322, 65, 'status', 'true');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (323, 65, 'current_nom', '2500.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (324, 65, 'voltage_nom', '220.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (325, 66, 'status', 'true');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (326, 66, 'current_nom', '2000.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (327, 66, 'voltage_nom', '220.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (328, 67, 'status', 'true');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (329, 67, 'current_nom', '2500.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (330, 67, 'voltage_nom', '330.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (331, 68, 'status', 'true');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (332, 68, 'current_nom', '3150.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (333, 68, 'voltage_nom', '500.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (334, 69, 'status', 'true');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (335, 69, 'current_nom', '3150.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (336, 69, 'voltage_nom', '750.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (337, 70, 'status', 'true');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (338, 70, 'current_nom', '1000.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (339, 70, 'voltage_nom', '10.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (340, 71, 'status', 'true');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (341, 71, 'current_nom', '1600.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (342, 71, 'voltage_nom', '10.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (343, 72, 'status', 'true');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (344, 72, 'current_nom', '1250.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (345, 72, 'voltage_nom', '35.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (346, 73, 'status', 'true');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (347, 73, 'current_nom', '1000.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (348, 73, 'voltage_nom', '110.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (349, 74, 'status', 'true');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (350, 74, 'current_nom', '2000.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (351, 74, 'voltage_nom', '110.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (352, 75, 'status', 'true');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (353, 75, 'current_nom', '1000.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (354, 75, 'voltage_nom', '220.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (355, 76, 'status', 'true');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (356, 76, 'current_nom', '2000.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (357, 76, 'voltage_nom', '220.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (358, 77, 'status', 'true');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (359, 77, 'current_nom', '2000.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (360, 77, 'voltage_nom', '330.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (361, 78, 'status', 'true');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (362, 78, 'current_nom', '3150.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (363, 78, 'voltage_nom', '500.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (364, 79, 'status', 'true');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (365, 79, 'current_nom', '3150.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (366, 79, 'voltage_nom', '750.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (367, 80, 'status', 'true');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (368, 80, 'current_nom', '1000.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (369, 80, 'voltage_nom', '10.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (370, 81, 'current_nom', '2000.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (371, 81, 'voltage_nom', '10.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (372, 82, 'current_nom', '1000.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (373, 82, 'voltage_nom', '35.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (374, 83, 'current_nom', '2000.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (375, 83, 'voltage_nom', '110.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (376, 84, 'current_nom', '2500.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (377, 84, 'voltage_nom', '220.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (378, 85, 'current_nom', '3150.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (379, 85, 'voltage_nom', '330.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (380, 86, 'current_nom', '4000.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (381, 86, 'voltage_nom', '500.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (382, 87, 'current_nom', '5000.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (383, 87, 'voltage_nom', '750.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (384, 88, 'status', 'false');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (385, 88, 'voltage_nom', '110.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (386, 89, 'status', 'false');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (387, 89, 'voltage_nom', '220.0');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (388, 90, 'status', 'false');
INSERT INTO equipment_model_params (id, equipment_model_id, param_key, param_value) VALUES (389, 90, 'voltage_nom', '500.0');


--
-- Data for Name: project_calculation_archives; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: project_editor_drafts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: project_members; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: project_passports; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: project_studies; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: project_study_versions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: project_study_runs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: project_study_run_leases; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: scheme_components; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: scheme_component_params; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: scheme_connections; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Name: auth_accounts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('auth_accounts_id_seq', 1, false);


--
-- Name: auth_sessions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('auth_sessions_id_seq', 1, false);


--
-- Name: circuit_schemes_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('circuit_schemes_id_seq', 1, false);


--
-- Name: component_params_template_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('component_params_template_id_seq', 77, true);


--
-- Name: component_types_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('component_types_id_seq', 13, true);


--
-- Name: equipment_model_params_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('equipment_model_params_id_seq', 389, true);


--
-- Name: equipment_models_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('equipment_models_id_seq', 90, true);


--
-- Name: project_calculation_archives_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('project_calculation_archives_id_seq', 1, false);


--
-- Name: project_passports_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('project_passports_id_seq', 1, false);


--
-- Name: project_studies_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('project_studies_id_seq', 1, false);


--
-- Name: project_study_runs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('project_study_runs_id_seq', 1, false);


--
-- Name: projects_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('projects_id_seq', 1, false);


--
-- Name: scheme_component_params_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('scheme_component_params_id_seq', 1, false);


--
-- Name: scheme_components_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('scheme_components_id_seq', 1, false);


--
-- Name: scheme_connections_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('scheme_connections_id_seq', 1, false);


--
-- PostgreSQL database dump complete
--


