-- Destructive maintenance: drops access scopes and membership history.
ALTER TABLE circuit_schemes DROP COLUMN project_id;
DROP TABLE project_members;
DROP TABLE projects;
