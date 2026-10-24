package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"time"
)

type studyVersion struct {
	Status           string        `json:"status"`
	ID               string        `json:"id"`
	ProjectID        string        `json:"projectId"`
	SchemeID         string        `json:"schemeId"`
	Revision         string        `json:"revision"`
	AuthorAccountID  string        `json:"authorAccountId"`
	TopologyRevision string        `json:"topologyRevision"`
	SchemeName       string        `json:"schemeName"`
	CreatedAt        time.Time     `json:"createdAt"`
	InputSHA256      string        `json:"inputSha256"`
	ProvenanceSHA256 string        `json:"provenanceSha256"`
	InputBytes       int64         `json:"inputBytes"`
	ProvenanceBytes  int64         `json:"provenanceBytes"`
	Document         studyDocument `json:"document"`
}

const studyColumns = `s.id,s.project_id,s.scheme_id,v.revision,v.author_account_id,v.topology_revision,v.scheme_name,v.created_at,
 v.input_sha256,v.provenance_sha256,octet_length(v.input_body),octet_length(v.provenance_body),v.document`

func scanStudy(row interface{ Scan(...any) error }) (studyVersion, error) {
	var result studyVersion
	var id, project, scheme, revision, author, topology int64
	var doc []byte
	err := row.Scan(&id, &project, &scheme, &revision, &author, &topology, &result.SchemeName, &result.CreatedAt,
		&result.InputSHA256, &result.ProvenanceSHA256, &result.InputBytes, &result.ProvenanceBytes, &doc)
	if err != nil {
		return result, err
	}
	if json.Unmarshal(doc, &result.Document) != nil || validateStudyDocument(result.Document) != nil {
		return result, errArchiveCorrupt
	}
	result.ID = strconv.FormatInt(id, 10)
	result.Status = "captured"
	result.ProjectID = strconv.FormatInt(project, 10)
	result.SchemeID = strconv.FormatInt(scheme, 10)
	result.Revision = strconv.FormatInt(revision, 10)
	result.AuthorAccountID = strconv.FormatInt(author, 10)
	result.TopologyRevision = strconv.FormatInt(topology, 10)
	return result, nil
}

func studyInTx(ctx context.Context, tx *sql.Tx, project, study, revision int64) (studyVersion, error) {
	return scanStudy(tx.QueryRowContext(ctx, `SELECT `+studyColumns+` FROM project_studies s JOIN project_study_versions v ON v.study_id=s.id
 WHERE s.project_id=$1 AND s.id=$2 AND v.revision=CASE WHEN $3::bigint=0 THEN s.current_revision ELSE $3 END`, project, study, revision))
}

// A replay is resolved before reading the mutable source. Retrying after a
// source edit returns the original immutable version, never a new capture.
func (store projectStore) studyReplay(ctx context.Context, token string, project int64, command, digest string) (studyVersion, bool, error) {
	var empty studyVersion
	tx, err := store.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return empty, false, err
	}
	defer tx.Rollback()
	if _, err = lockArchiveProject(ctx, tx, token, project, true); err != nil {
		return empty, false, err
	}
	version, found, err := studyReplayInTx(ctx, tx, project, command, digest)
	if err != nil {
		return empty, false, err
	}
	if err = tx.Commit(); err != nil {
		return empty, false, err
	}
	return version, found, nil
}
func studyReplayInTx(ctx context.Context, tx *sql.Tx, project int64, command, digest string) (studyVersion, bool, error) {
	var study, revision int64
	var actual string
	err := tx.QueryRowContext(ctx, `SELECT study_id,revision,command_sha256 FROM project_study_versions WHERE project_id=$1 AND command_id=$2`, project, command).Scan(&study, &revision, &actual)
	if errors.Is(err, sql.ErrNoRows) {
		return studyVersion{}, false, nil
	}
	if err != nil {
		return studyVersion{}, false, err
	}
	if actual != digest {
		return studyVersion{}, false, errStudyCommand
	}
	v, err := studyInTx(ctx, tx, project, study, revision)
	return v, true, err
}

func (store projectStore) SaveStudy(ctx context.Context, token string, project int64, scheme int, study, expected, topology int64, command string, doc studyDocument) (studyVersion, error) {
	var empty studyVersion
	if project <= 0 || study < 0 || expected < 0 || expected >= math.MaxInt64 || topology < 0 || !commandUUID.MatchString(command) ||
		(study == 0 && (scheme <= 0 || expected != 0)) || (study > 0 && expected == 0) || validateStudyDocument(doc) != nil {
		return empty, errStudyInput
	}
	if study > 0 {
		identity, _, err := store.ReadStudy(ctx, token, project, study, 0, "")
		if err != nil {
			return empty, err
		}
		value, err := strconv.Atoi(identity.SchemeID)
		if err != nil {
			return empty, err
		}
		scheme = value
	}
	commandBody, err := json.Marshal(struct {
		Scheme                    int
		Study, Expected, Topology int64
		Document                  studyDocument
	}{scheme, study, expected, topology, doc})
	if err != nil {
		return empty, errStudyInput
	}
	digest := archiveDigest(commandBody)
	if replay, found, err := store.studyReplay(ctx, token, project, command, digest); err != nil || found {
		return replay, err
	}
	// This independent REPEATABLE READ source includes the exact parameters and
	// passport evidence. The short write transaction below rechecks live access.
	input, err := readCalculationInputScope(ctx, store.database, scheme, project, token, true)
	if err != nil {
		if replay, found, replayErr := store.studyReplay(ctx, token, project, command, digest); replayErr != nil || found {
			return replay, replayErr
		}
		return empty, err
	}
	if input.TopologyRevision != topology {
		return empty, errStudyTopology
	}
	if !limitTargetsBelongToInput(doc.Limits, input) {
		return empty, errStudyInput
	}
	document, err := json.Marshal(doc)
	if err != nil || len(document) > 128<<10 {
		return empty, errStudyInput
	}
	tx, err := store.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return empty, err
	}
	defer tx.Rollback()
	account, err := lockArchiveProject(ctx, tx, token, project, true)
	if err != nil {
		return empty, err
	}
	if account != input.AuthorAccountID {
		return empty, sql.ErrNoRows
	}
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('enersy-studies:' || $1::text,0))`, project); err != nil {
		return empty, err
	}
	if replay, found, err := studyReplayInTx(ctx, tx, project, command, digest); err != nil || found {
		if err != nil {
			return empty, err
		}
		if err = tx.Commit(); err != nil {
			return empty, err
		}
		return replay, nil
	}
	var currentTopology int64
	if err = tx.QueryRowContext(ctx, `SELECT topology_revision FROM circuit_schemes WHERE id=$1 AND project_id=$2 FOR SHARE`, scheme, project).Scan(&currentTopology); err != nil {
		return empty, err
	}
	if currentTopology != topology {
		return empty, errStudyTopology
	}
	if study > 0 {
		var current int64
		if err = tx.QueryRowContext(ctx, `SELECT current_revision FROM project_studies WHERE id=$1 AND project_id=$2 AND scheme_id=$3 FOR UPDATE`, study, project, scheme).Scan(&current); err != nil {
			return empty, err
		}
		if current != expected {
			return empty, errStudyConflict
		}
	}
	var count, size int64
	if err = tx.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(octet_length(input_body)::bigint+octet_length(provenance_body)+octet_length(document::text)),0) FROM project_study_versions WHERE project_id=$1`, project).Scan(&count, &size); err != nil {
		return empty, err
	}
	if count >= 100 {
		return empty, errStudyQuota
	}
	if study == 0 {
		if err = tx.QueryRowContext(ctx, `INSERT INTO project_studies(project_id,scheme_id,current_revision,created_by) VALUES($1,$2,1,$3) RETURNING id`, project, scheme, account).Scan(&study); err != nil {
			return empty, err
		}
	}
	revision := expected + 1
	body, err := studyWorkerInput(input, doc, strconv.FormatInt(study, 10), strconv.FormatInt(revision, 10))
	if err != nil {
		return empty, err
	}
	var storedDocumentBytes int64
	if err = tx.QueryRowContext(ctx, `SELECT octet_length($1::jsonb::text)`, string(document)).Scan(&storedDocumentBytes); err != nil {
		return empty, err
	}
	if len(body) > computeBodyLimit || len(input.Provenance) == 0 || len(input.Provenance) > computeBodyLimit || storedDocumentBytes > 128<<10 || size+int64(len(body)+len(input.Provenance))+storedDocumentBytes > 64<<20 {
		return empty, errStudyQuota
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO project_study_versions(study_id,project_id,revision,author_account_id,command_id,command_sha256,topology_revision,scheme_name,document,input_body,provenance_body)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`, study, project, revision, account, command, digest, topology, input.SchemeName, string(document), body, input.Provenance); err != nil {
		return empty, err
	}
	if expected > 0 {
		if _, err = tx.ExecContext(ctx, `UPDATE project_studies SET current_revision=$3 WHERE id=$1 AND project_id=$2`, study, project, revision); err != nil {
			return empty, err
		}
	}
	result, err := studyInTx(ctx, tx, project, study, revision)
	if err != nil {
		return empty, err
	}
	if _, err = lockArchiveProject(ctx, tx, token, project, true); err != nil {
		return empty, err
	}
	if err = tx.Commit(); err != nil {
		return empty, err
	}
	return result, nil
}

func (store projectStore) ReadStudy(ctx context.Context, token string, project, study, revision int64, kind string) (studyVersion, []byte, error) {
	var empty studyVersion
	if project <= 0 || study <= 0 || revision < 0 || (kind != "" && kind != "input" && kind != "provenance") {
		return empty, nil, errStudyInput
	}
	tx, err := store.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return empty, nil, err
	}
	defer tx.Rollback()
	if _, err = lockArchiveProject(ctx, tx, token, project, false); err != nil {
		return empty, nil, err
	}
	result, err := studyInTx(ctx, tx, project, study, revision)
	if err != nil {
		return empty, nil, err
	}
	var body []byte
	if kind != "" {
		column, digest := "input_body", result.InputSHA256
		if kind == "provenance" {
			column, digest = "provenance_body", result.ProvenanceSHA256
		}
		if err = tx.QueryRowContext(ctx, `SELECT `+column+` FROM project_study_versions WHERE study_id=$1 AND revision=$2`, study, result.Revision).Scan(&body); err != nil {
			return empty, nil, err
		}
		if archiveDigest(body) != digest {
			return empty, nil, errArchiveCorrupt
		}
	}
	if _, err = lockArchiveProject(ctx, tx, token, project, false); err != nil {
		return empty, nil, err
	}
	if err = tx.Commit(); err != nil {
		return empty, nil, err
	}
	return result, body, nil
}

func (store projectStore) ListStudies(ctx context.Context, token string, project, study, after int64, limit int) ([]studyVersion, error) {
	if project <= 0 || study < 0 || after < 0 || limit < 1 || limit > 100 {
		return nil, errStudyInput
	}
	tx, err := store.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = lockArchiveProject(ctx, tx, token, project, false); err != nil {
		return nil, err
	}
	if study > 0 {
		if _, err = studyInTx(ctx, tx, project, study, 0); err != nil {
			return nil, err
		}
	}
	rows, err := tx.QueryContext(ctx, `SELECT `+studyColumns+` FROM project_studies s JOIN project_study_versions v ON v.study_id=s.id AND ($4::bigint>0 OR v.revision=s.current_revision)
 WHERE s.project_id=$1 AND (($4=0 AND s.id>$2) OR (s.id=$4 AND v.revision>$2)) ORDER BY s.id,v.revision LIMIT $3`, project, after, limit, study)
	if err != nil {
		return nil, err
	}
	items := []studyVersion{}
	for rows.Next() {
		item, err := scanStudy(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if _, err = lockArchiveProject(ctx, tx, token, project, false); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return items, nil
}
