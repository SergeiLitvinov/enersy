package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"regexp"
	"strconv"
)

var studySourceDigestPattern = regexp.MustCompile(`^v1:[0-9a-f]{64}$`)

// Canonical ASCII stream: domain line, scheme ID line, then ordered id:revision
// lines. No geometry, floating-point formatting or JSON codec participates.
func studySourceDigest(scheme int, components []calculationComponent) string {
	hash := sha256.New()
	fmt.Fprintf(hash, "enersy-study-source-v1\n%d\n", scheme)
	for _, component := range components {
		fmt.Fprintf(hash, "%d:%d\n", component.ID, component.Revision)
	}
	return "v1:" + hex.EncodeToString(hash.Sum(nil))
}

// A complete, ID-ordered manifest from the client's coherent scheme snapshot.
// Nil retains the legacy capture contract; an explicit empty list means no objects.
type studySourceRevision struct {
	ID       string `json:"id"`
	Revision string `json:"revision"`
}

func validateStudySourceManifest(source *[]studySourceRevision) error {
	if source == nil {
		return nil
	}
	if *source == nil || len(*source) > 100000 {
		return errStudyInput
	}
	var previous int64
	for _, item := range *source {
		id, e1 := strconv.ParseInt(item.ID, 10, 32)
		revision, e2 := strconv.ParseInt(item.Revision, 10, 64)
		if e1 != nil || e2 != nil || id <= previous || revision <= 0 ||
			strconv.FormatInt(id, 10) != item.ID || strconv.FormatInt(revision, 10) != item.Revision {
			return errStudyInput
		}
		previous = id
	}
	return nil
}

func matchStudySourceManifest(source *[]studySourceRevision, captured []calculationComponent) error {
	if source == nil {
		return nil
	}
	if len(*source) != len(captured) {
		return errStudySource
	}
	for _, item := range *source {
		if len(captured) == 0 {
			return errStudySource
		}
		if item.ID != strconv.Itoa(captured[0].ID) || item.Revision != strconv.FormatInt(captured[0].Revision, 10) {
			return errStudySource
		}
		captured = captured[1:]
	}
	return nil
}

// Called after the project/scheme locks in the short Study write transaction.
// Component SHARE locks also block the parameter revision trigger, including
// direct SQL writers, until the immutable version has committed or rolled back.
func checkStudySourceRevisions(ctx context.Context, tx *sql.Tx, scheme int, captured []calculationComponent) error {
	rows, err := tx.QueryContext(ctx, `SELECT id,revision FROM scheme_components WHERE scheme_id=$1 ORDER BY id FOR SHARE`, scheme)
	if err != nil {
		return err
	}
	defer rows.Close()
	index := 0
	for rows.Next() {
		var id int
		var revision int64
		if err := rows.Scan(&id, &revision); err != nil {
			return err
		}
		if index >= len(captured) || captured[index].ID != id || captured[index].Revision != revision {
			return errStudySource
		}
		index++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if index != len(captured) {
		return errStudySource
	}
	return nil
}
