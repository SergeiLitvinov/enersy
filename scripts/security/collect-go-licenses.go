// Run with the same locked Go SDK that built the binary. No package code is run.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"debug/buildinfo"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const maxNoticeBytes = 1024 * 1024

var noticeFileName = regexp.MustCompile(`(?i)^(licen[sc]e|copying|notice|copyright|patents)([-_][a-z0-9-]+)?(\.(txt|md|markdown|rst|text|html))?$|^third[-_]?party[-_ ]?(notices?|licen[sc]es?)(\.(txt|md|markdown|rst|text|html))?$`)

type noticeFile struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
}

type goModule struct {
	Path    string
	Version string
	Sum     string
	Dir     string
	Replace *goModule
}

type moduleNotice struct {
	Path          string       `json:"path"`
	Version       string       `json:"version"`
	Sum           string       `json:"sum,omitempty"`
	Files         []noticeFile `json:"noticeFiles"`
	MissingNotice bool         `json:"missingNotice"`
}

type sourceNoticeInventory struct {
	Scope string       `json:"scope"`
	Files []noticeFile `json:"noticeFiles"`
}

type goLicenseReport struct {
	FormatVersion int                   `json:"formatVersion"`
	Scope         string                `json:"scope"`
	CapturedUTC   time.Time             `json:"capturedUtc"`
	GoVersion     string                `json:"goVersion"`
	MainModule    string                `json:"mainModule"`
	BinarySHA256  string                `json:"binarySha256"`
	GoModSHA256   string                `json:"goModSha256"`
	GoSumSHA256   string                `json:"goSumSha256"`
	CacheVerified bool                  `json:"moduleCacheVerified"`
	Modules       []moduleNotice        `json:"modules"`
	Toolchain     moduleNotice          `json:"toolchain"`
	SDKSource     sourceNoticeInventory `json:"sdkSource"`
	Notices       map[string]string     `json:"notices"`
	Limitations   []string              `json:"limitations"`
}

func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func inside(root, candidate string) bool {
	rel, err := filepath.Rel(root, candidate)
	return err == nil && rel != ".." && !filepath.IsAbs(rel) && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func collectNotices(directory string, notices map[string]string) ([]noticeFile, error) {
	root, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	files := []noticeFile{}
	for _, entry := range entries {
		if !noticeFileName.MatchString(entry.Name()) || entry.IsDir() {
			continue
		}
		file, err := readNotice(root, entry.Name(), notices)
		if err != nil {
			return nil, err
		}
		files = append(files, file)
	}
	return files, nil
}

func readNotice(root, relative string, notices map[string]string) (noticeFile, error) {
	name, err := filepath.EvalSymlinks(filepath.Join(root, relative))
	if err != nil {
		return noticeFile{}, err
	}
	if !inside(root, name) {
		return noticeFile{}, fmt.Errorf("notice escapes source directory")
	}
	info, err := os.Stat(name)
	if err != nil {
		return noticeFile{}, err
	}
	if !info.Mode().IsRegular() {
		return noticeFile{}, fmt.Errorf("notice is not a regular file")
	}
	file, err := os.Open(name)
	if err != nil {
		return noticeFile{}, err
	}
	data, readErr := io.ReadAll(io.LimitReader(file, maxNoticeBytes+1))
	closeErr := file.Close()
	if readErr != nil {
		return noticeFile{}, readErr
	}
	if closeErr != nil {
		return noticeFile{}, closeErr
	}
	if len(data) == 0 || len(data) > maxNoticeBytes || !utf8.Valid(data) {
		return noticeFile{}, fmt.Errorf("notice is empty, oversized or invalid UTF-8")
	}
	hash := digest(data)
	notices[hash] = string(data)
	return noticeFile{Name: filepath.ToSlash(relative), SHA256: hash}, nil
}

// This inventories all SDK src notices, including build tools and test data.
// It deliberately makes no claim that these files are linked into the binary.
func collectSDKSourceNotices(directory string, notices map[string]string) (sourceNoticeInventory, error) {
	r := sourceNoticeInventory{Scope: "all-go-sdk-src-notice-files", Files: []noticeFile{}}
	root, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return r, err
	}
	source := filepath.Join(root, "src")
	info, err := os.Stat(source)
	if err != nil {
		return r, err
	}
	if !info.IsDir() {
		return r, fmt.Errorf("SDK src is not a directory")
	}
	err = filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			target, err := filepath.EvalSymlinks(path)
			if err != nil {
				return err
			}
			info, err := os.Stat(target)
			if err != nil {
				return err
			}
			// WalkDir does not descend into directory links. Refuse rather
			// than silently reporting a partial SDK source inventory.
			if info.IsDir() || !inside(root, target) {
				return fmt.Errorf("SDK source contains a directory link or escaping link")
			}
		}
		if entry.IsDir() || !noticeFileName.MatchString(entry.Name()) {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		file, err := readNotice(root, relative, notices)
		if err != nil {
			return err
		}
		r.Files = append(r.Files, file)
		return nil
	})
	return r, err
}

func validateModule(selected *debug.Module, metadata goModule, cache string) error {
	if selected.Replace != nil || metadata.Replace != nil {
		return fmt.Errorf("replacement modules require a separate provenance review")
	}
	if metadata.Path != selected.Path || metadata.Version != selected.Version ||
		metadata.Sum == "" || metadata.Sum != selected.Sum || metadata.Dir == "" {
		return fmt.Errorf("module does not match the built binary")
	}
	root, err := filepath.EvalSymlinks(metadata.Dir)
	if err != nil {
		return err
	}
	if !inside(cache, root) || root == cache {
		return fmt.Errorf("module source escapes module cache")
	}
	return nil
}

func goOutput(ctx context.Context, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "go", args...)
	cmd.Env = append(os.Environ(), "GOTOOLCHAIN=local", "GOWORK=off", "GOPROXY=off", "GOSUMDB=off")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		// Do not publish local directories or environment values in the report.
		return nil, fmt.Errorf("Go metadata command failed: %w", err)
	}
	return output, nil
}

func inventory(ctx context.Context, binary string) (goLicenseReport, error) {
	r := goLicenseReport{FormatVersion: 2, Scope: "go-binary-module-notices", CapturedUTC: time.Now().UTC(), Modules: []moduleNotice{}, Notices: map[string]string{}, Limitations: []string{
		"Module-level notices, not a source-file licensing or license compatibility decision",
		"SDK source notices include all src subdirectories, build tools and test data, not a list of code linked into the binary",
		"Source-file embedded attributions, notices outside SDK src/root, license compatibility and operating-system packages require separate review",
		"Only modules selected in this binary; plugins and other build variants require separate inventories",
	}}
	info, err := buildinfo.ReadFile(binary)
	if err != nil {
		return r, err
	}
	envBytes, err := goOutput(ctx, "env", "-json", "GOVERSION", "GOROOT", "GOMOD", "GOMODCACHE")
	if err != nil {
		return r, err
	}
	var env map[string]string
	if err = json.Unmarshal(envBytes, &env); err != nil {
		return r, err
	}
	if env["GOVERSION"] != info.GoVersion || env["GOMOD"] == "" || env["GOMOD"] == os.DevNull {
		return r, fmt.Errorf("binary SDK or module environment mismatch")
	}
	cache, err := filepath.EvalSymlinks(env["GOMODCACHE"])
	if err != nil {
		return r, err
	}
	mod, err := os.ReadFile(env["GOMOD"])
	if err != nil {
		return r, err
	}
	sumFile := filepath.Join(filepath.Dir(env["GOMOD"]), "go.sum")
	sums, err := os.ReadFile(sumFile)
	if err != nil {
		return r, err
	}
	r.GoVersion, r.GoModSHA256, r.GoSumSHA256 = info.GoVersion, digest(mod), digest(sums)
	if _, err = goOutput(ctx, "mod", "verify"); err != nil {
		return r, err
	}
	r.CacheVerified = true
	mainBytes, err := goOutput(ctx, "list", "-m", "-json", "-mod=readonly")
	if err != nil {
		return r, err
	}
	var mainModule goModule
	if err = json.Unmarshal(mainBytes, &mainModule); err != nil {
		return r, err
	}
	if info.Main.Path == "" || mainModule.Path != info.Main.Path || filepath.Clean(mainModule.Dir) != filepath.Dir(env["GOMOD"]) {
		return r, fmt.Errorf("binary main module does not match source module")
	}
	r.MainModule = info.Main.Path
	bin, err := os.Open(binary)
	if err != nil {
		return r, err
	}
	hash := sha256.New()
	_, copyErr := io.Copy(hash, bin)
	closeErr := bin.Close()
	if copyErr != nil {
		return r, copyErr
	}
	if closeErr != nil {
		return r, closeErr
	}
	r.BinarySHA256 = hex.EncodeToString(hash.Sum(nil))
	for _, selected := range info.Deps {
		output, err := goOutput(ctx, "list", "-m", "-json", "-mod=readonly", selected.Path)
		if err != nil {
			return r, err
		}
		var metadata goModule
		if err = json.Unmarshal(output, &metadata); err != nil {
			return r, err
		}
		if err = validateModule(selected, metadata, cache); err != nil {
			return r, fmt.Errorf("%s: %w", selected.Path, err)
		}
		files, err := collectNotices(metadata.Dir, r.Notices)
		if err != nil {
			return r, fmt.Errorf("%s: %w", selected.Path, err)
		}
		r.Modules = append(r.Modules, moduleNotice{Path: selected.Path, Version: selected.Version, Sum: selected.Sum, Files: files, MissingNotice: len(files) == 0})
	}
	sort.Slice(r.Modules, func(i, j int) bool { return r.Modules[i].Path < r.Modules[j].Path })
	files, err := collectNotices(env["GOROOT"], r.Notices)
	if err != nil {
		return r, err
	}
	r.Toolchain = moduleNotice{Path: "go", Version: info.GoVersion, Files: files, MissingNotice: len(files) == 0}
	r.SDKSource, err = collectSDKSourceNotices(env["GOROOT"], r.Notices)
	if err != nil {
		return r, err
	}
	for file, expected := range map[string]string{env["GOMOD"]: r.GoModSHA256, sumFile: r.GoSumSHA256} {
		data, err := os.ReadFile(file)
		if err != nil || digest(data) != expected {
			return r, fmt.Errorf("module lock inputs changed during inventory")
		}
	}
	return r, nil
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "Usage: collect-go-licenses BINARY REPORT.json")
		os.Exit(1)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	r, err := inventory(ctx, os.Args[1])
	if err == nil {
		var data []byte
		data, err = json.MarshalIndent(r, "", "  ")
		if err == nil {
			err = os.WriteFile(os.Args[2], append(data, '\n'), 0o644)
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("%d modules selected in binary; Go %s notices captured\n", len(r.Modules), r.GoVersion)
}
