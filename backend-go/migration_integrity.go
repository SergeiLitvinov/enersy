package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sort"

	"github.com/golang-migrate/migrate/v4/database"
	"github.com/golang-migrate/migrate/v4/source"
)

type migrationScript struct {
	body []byte
	name string
	hash string
}

// Freeze the bytes before checking hashes, so execution uses exactly the
// checked contents even if a developer edits a file during startup.
type migrationSnapshotSource struct {
	source.Driver
	scripts map[uint]migrationScript
}

func snapshotMigrations(files source.Driver) (*migrationSnapshotSource, error) {
	snapshot := &migrationSnapshotSource{Driver: files, scripts: map[uint]migrationScript{}}
	version, err := files.First()
	if err != nil {
		return nil, fmt.Errorf("empty or unreadable migration source: %w", err)
	}
	for {
		reader, name, err := files.ReadUp(version)
		if err != nil {
			return nil, fmt.Errorf("migration %d read: %w", version, err)
		}
		body, readErr := io.ReadAll(reader)
		closeErr := reader.Close()
		if err := errors.Join(readErr, closeErr); err != nil {
			return nil, fmt.Errorf("migration %d read: %w", version, err)
		}
		// Git on Windows may change newline encoding; SQL semantics are the
		// same. Preserve every other byte, including whitespace and comments.
		body = bytes.ReplaceAll(body, []byte("\r\n"), []byte("\n"))
		snapshot.scripts[version] = migrationScript{body: body, name: name, hash: fmt.Sprintf("%x", sha256.Sum256(body))}
		next, err := files.Next(version)
		if errors.Is(err, os.ErrNotExist) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("migration source versions: %w", err)
		}
		version = next
	}
	return snapshot, nil
}

func (s *migrationSnapshotSource) ReadUp(version uint) (io.ReadCloser, string, error) {
	script, ok := s.scripts[version]
	if !ok {
		return nil, "", os.ErrNotExist
	}
	return io.NopCloser(bytes.NewReader(script.body)), script.name, nil
}

type integrityDriver struct {
	database.Driver
	conn   *sql.Conn
	source *migrationSnapshotSource
	latest uint
}

// Integrity validation and enrollment share the same PostgreSQL advisory lock
// as golang-migrate. Concurrent API starts cannot overwrite each other's seal.
func (d *integrityDriver) Lock() error {
	if err := d.Driver.Lock(); err != nil {
		return err
	}
	if err := d.checkIntegrity(); err != nil {
		return errors.Join(err, d.Driver.Unlock())
	}
	return nil
}

func (d *integrityDriver) checkIntegrity() error {
	version, dirty, err := d.Driver.Version()
	if err != nil {
		return err
	}
	if dirty {
		return fmt.Errorf("dirty database migration version %d; manual recovery required", version)
	}
	if version >= 0 {
		if uint(version) > d.latest {
			return fmt.Errorf("database version %d is newer than supported version %d", version, d.latest)
		}
		if _, ok := d.source.scripts[uint(version)]; !ok {
			return fmt.Errorf("database version %d is absent from migration source", version)
		}
	}
	ctx := context.Background()
	var exists bool
	if err := d.conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname='schema_migration_integrity')`).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		tx, err := d.conn.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if _, err := tx.ExecContext(ctx, `CREATE TABLE schema_migration_integrity (
version BIGINT PRIMARY KEY, sha256 CHAR(64) NOT NULL,
origin VARCHAR(16) NOT NULL CHECK(origin IN ('applied','legacy-baseline')),
recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`); err != nil {
			return err
		}
		for _, v := range d.orderedVersions() {
			if version < 0 || v > uint(version) {
				break
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migration_integrity(version,sha256,origin) VALUES($1,$2,'legacy-baseline')`, v, d.source.scripts[v].hash); err != nil {
				return err
			}
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		if version >= 0 {
			slog.Warn("enrolled legacy migration baseline; prior SQL contents cannot be verified", "version", version)
		}
		return nil
	}
	rows, err := d.conn.QueryContext(ctx, `SELECT version,sha256 FROM schema_migration_integrity ORDER BY version`)
	if err != nil {
		return err
	}
	defer rows.Close()
	found := map[uint]bool{}
	for rows.Next() {
		var v int64
		var hash string
		if err := rows.Scan(&v, &hash); err != nil {
			return err
		}
		if v < 0 || v > int64(version) {
			return fmt.Errorf("migration integrity history ahead of database at %d", v)
		}
		script, ok := d.source.scripts[uint(v)]
		if !ok {
			return fmt.Errorf("sealed migration %d is missing from source", v)
		}
		if script.hash != hash {
			return fmt.Errorf("migration %d checksum mismatch; restore original SQL instead of editing applied migration", v)
		}
		found[uint(v)] = true
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, v := range d.orderedVersions() {
		if version >= 0 && v <= uint(version) && !found[v] {
			return fmt.Errorf("migration %d integrity record is missing", v)
		}
	}
	return nil
}

func (d *integrityDriver) orderedVersions() []uint {
	versions := make([]uint, 0, len(d.source.scripts))
	for v := range d.source.scripts {
		versions = append(versions, v)
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i] < versions[j] })
	return versions
}

// Persist the digest BEFORE executing SQL. A crash after SQL execution cannot
// lose the seal; golang-migrate's dirty state still controls recovery.
func (d *integrityDriver) SetVersion(version int, dirty bool) error {
	if dirty {
		script, ok := d.source.scripts[uint(version)]
		if !ok {
			return fmt.Errorf("migration %d missing from frozen source", version)
		}
		if _, err := d.conn.ExecContext(context.Background(), `INSERT INTO schema_migration_integrity(version,sha256,origin) VALUES($1,$2,'applied')`, version, script.hash); err != nil {
			return fmt.Errorf("migration integrity record: %w", err)
		}
	}
	return d.Driver.SetVersion(version, dirty)
}
