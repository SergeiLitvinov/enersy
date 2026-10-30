package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"testing"
)

func TestNoticesPreserveExactText(t *testing.T) {
	root := t.TempDir()
	text := "\ufeffCopyright © Авторы\r\nPermission and disclaimer\r\n"
	for _, name := range []string{"LICENSE", "COPYING.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"README.md", "notice.go", "notice_example_test.go", "license.json"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("Source or link, not a license text"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	notices := map[string]string{}
	files, err := collectNotices(root, notices)
	if err != nil || len(files) != 2 || len(notices) != 1 {
		t.Fatalf("files=%v notices=%v err=%v", files, notices, err)
	}
	data, err := json.Marshal(notices)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]string
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded[digest([]byte(text))] != text || files[0].Name != "COPYING.txt" || files[1].Name != "LICENSE" {
		t.Fatal("attribution bytes or deterministic ordering changed")
	}
}

func TestNoticeSourceFailures(t *testing.T) {
	for _, tc := range []struct {
		name string
		data []byte
	}{
		{"empty", nil},
		{"invalid-utf8", []byte{0xff, 0xfe}},
		{"oversized", []byte(strings.Repeat("a", maxNoticeBytes+1))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, "LICENSE"), tc.data, 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := collectNotices(root, map[string]string{}); err == nil {
				t.Fatal("invalid evidence accepted")
			}
		})
	}
	t.Run("outside-link", func(t *testing.T) {
		root := t.TempDir()
		outside := filepath.Join(t.TempDir(), "private.txt")
		if err := os.WriteFile(outside, []byte("Not a module notice"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, filepath.Join(root, "LICENSE")); err != nil {
			t.Fatal(err)
		}
		if _, err := collectNotices(root, map[string]string{}); err == nil || !strings.Contains(err.Error(), "escapes") {
			t.Fatalf("outside notice was not rejected: %v", err)
		}
	})
}

func TestBinaryModulesRequireExactMetadata(t *testing.T) {
	cache := t.TempDir()
	dir := filepath.Join(cache, "module@v1.0.0")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	selected := &debug.Module{Path: "example.org/module", Version: "v1.0.0", Sum: "h1:locked"}
	valid := goModule{Path: selected.Path, Version: selected.Version, Sum: selected.Sum, Dir: dir}
	if err := validateModule(selected, valid, cache); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"path", "version", "sum", "missing-dir", "outside-cache", "replacement"} {
		t.Run(field, func(t *testing.T) {
			metadata := valid
			switch field {
			case "path":
				metadata.Path += "other"
			case "version":
				metadata.Version = "v1.0.1"
			case "sum":
				metadata.Sum = "h1:different"
			case "missing-dir":
				metadata.Dir = ""
			case "outside-cache":
				metadata.Dir = t.TempDir()
			case "replacement":
				metadata.Replace = &goModule{Path: "example.org/other"}
			}
			if err := validateModule(selected, metadata, cache); err == nil {
				t.Fatal("unrelated module sources accepted")
			}
		})
	}
	selected.Replace = &debug.Module{Path: "example.org/other"}
	if err := validateModule(selected, valid, cache); err == nil {
		t.Fatal("binary replacement accepted without review")
	}
}

func TestMissingNoticeStaysMissing(t *testing.T) {
	files, err := collectNotices(t.TempDir(), map[string]string{})
	if err != nil || files == nil || len(files) != 0 {
		t.Fatalf("missing evidence changed: %v %v", files, err)
	}
}

func TestSDKSourceNoticePathsAndExactBytes(t *testing.T) {
	root := t.TempDir()
	text := "\ufeff© Вложенный автор\r\nFull permission and disclaimer\r\n"
	names := []string{"src/crypto/internal/example/LICENSE", "src/vendor/example.org/module/PATENTS", "src/cmd/vendor/other/NOTICE.txt"}
	for _, name := range names {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "LICENSE"), []byte("Root collected separately"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "notice.go"), []byte("Not a notice"), 0o600); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "src", "vendor", "example.org", "module", "LICENSE")
	if err := os.Symlink(filepath.Join(root, filepath.FromSlash(names[0])), alias); err != nil {
		t.Fatal(err)
	}
	notices := map[string]string{}
	r, err := collectSDKSourceNotices(root, notices)
	if err != nil || r.Scope != "all-go-sdk-src-notice-files" || len(r.Files) != 4 || len(notices) != 1 {
		t.Fatalf("%+v %v", r, err)
	}
	if r.Files[0].Name != names[2] || r.Files[1].Name != names[0] || r.Files[2].Name != "src/vendor/example.org/module/LICENSE" || r.Files[3].Name != names[1] {
		t.Fatalf("paths/order changed: %+v", r.Files)
	}
	data, err := json.Marshal(notices)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]string
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, file := range r.Files {
		if file.SHA256 != digest([]byte(text)) || decoded[file.SHA256] != text {
			t.Fatal("nested notice bytes changed")
		}
	}
}

func TestSDKSourceNoticeRefusals(t *testing.T) {
	for _, kind := range []string{"missing-src", "src-file", "empty", "invalid-utf8", "oversized", "outside-file", "outside-directory", "inside-directory"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			if kind != "missing-src" && kind != "src-file" {
				if err := os.MkdirAll(filepath.Join(root, "src", "vendor"), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			path := filepath.Join(root, "src", "vendor", "LICENSE")
			var err error
			switch kind {
			case "src-file":
				err = os.WriteFile(filepath.Join(root, "src"), []byte("Not a directory"), 0o600)
			case "empty":
				err = os.WriteFile(path, nil, 0o600)
			case "invalid-utf8":
				err = os.WriteFile(path, []byte{0xff}, 0o600)
			case "oversized":
				err = os.WriteFile(path, []byte(strings.Repeat("a", maxNoticeBytes+1)), 0o600)
			case "outside-file":
				outside := filepath.Join(t.TempDir(), "LICENSE")
				if err = os.WriteFile(outside, []byte("Outside"), 0o600); err == nil {
					err = os.Symlink(outside, path)
				}
			case "outside-directory":
				err = os.Symlink(t.TempDir(), filepath.Join(root, "src", "external"))
			case "inside-directory":
				err = os.Symlink(filepath.Join(root, "src", "vendor"), filepath.Join(root, "src", "alias"))
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := collectSDKSourceNotices(root, map[string]string{}); err == nil {
				t.Fatal("partial or invalid SDK inventory accepted")
			}
		})
	}
}

func TestActualSDKContainsVendoredSourceNotices(t *testing.T) {
	notices := map[string]string{}
	r, err := collectSDKSourceNotices(runtime.GOROOT(), notices)
	if err != nil {
		t.Fatal(err)
	}
	wanted := map[string]bool{"src/vendor/golang.org/x/crypto/LICENSE": false, "src/vendor/golang.org/x/crypto/PATENTS": false, "src/cmd/vendor/github.com/google/pprof/third_party/svgpan/LICENSE": false, "src/crypto/internal/boring/LICENSE": false}
	for _, file := range r.Files {
		if _, ok := wanted[file.Name]; ok {
			wanted[file.Name] = true
		}
		if filepath.IsAbs(file.Name) || strings.Contains(file.Name, "\\") || digest([]byte(notices[file.SHA256])) != file.SHA256 {
			t.Fatal("SDK report path or notice hash invalid")
		}
	}
	for name, found := range wanted {
		if !found {
			t.Fatalf("SDK notice missing: %s", name)
		}
	}
	t.Logf("Go %s: %d SDK src notices, %d distinct texts", runtime.Version(), len(r.Files), len(notices))
}

func TestNestedInventoriesKeepScopesAndRootEvidence(t *testing.T) {
	root := t.TempDir()
	texts := map[string]string{
		"LICENSE":                "Root permission\r\n",
		"src/vendor/NOTICE":      "Source permission\n",
		"lib/time/LICENSE":       "\ufeffNested © author\r\nFull permission\r\n",
		"misc/tools/COPYING.txt": "\ufeffNested © author\r\nFull permission\r\n",
		"misc/notice.go":         "Not a named notice",
	}
	for name, text := range texts {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	notices := map[string]string{}
	other, err := collectSDKOtherNotices(root, notices)
	if err != nil || other.Scope != "go-sdk-nested-notice-files-outside-src" || len(other.Files) != 2 || len(notices) != 1 {
		t.Fatalf("%+v %v", other, err)
	}
	if other.Files[0].Name != "lib/time/LICENSE" || other.Files[1].Name != "misc/tools/COPYING.txt" {
		t.Fatal(other.Files)
	}
	for _, file := range other.Files {
		if notices[file.SHA256] != texts[file.Name] || file.SHA256 != digest([]byte(texts[file.Name])) {
			t.Fatal("nested notice bytes changed")
		}
	}
	nested, err := collectModuleNestedNotices(root, notices)
	if err != nil || nested.Scope != "all-selected-module-nested-notice-files" || len(nested.Files) != 3 {
		t.Fatalf("%+v %v", nested, err)
	}
	// Finding a nested notice must not imply a missing root license is resolved.
	if err := os.Remove(filepath.Join(root, "LICENSE")); err != nil {
		t.Fatal(err)
	}
	files, err := collectNotices(root, notices)
	if err != nil || len(files) != 0 {
		t.Fatalf("root evidence invented: %v %v", files, err)
	}
}

func TestNestedInventoriesRejectUnsafeEvidence(t *testing.T) {
	for _, kind := range []string{"empty", "oversized", "invalid-utf8", "outside-file", "outside-directory", "inside-directory", "linked-src"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			dir := filepath.Join(root, "lib")
			if err := os.Mkdir(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, "NOTICE")
			var err error
			switch kind {
			case "empty":
				err = os.WriteFile(path, nil, 0o600)
			case "oversized":
				err = os.WriteFile(path, []byte(strings.Repeat("a", maxNoticeBytes+1)), 0o600)
			case "invalid-utf8":
				err = os.WriteFile(path, []byte{0xff}, 0o600)
			case "outside-file":
				outside := filepath.Join(t.TempDir(), "private")
				if err = os.WriteFile(outside, []byte("Private"), 0o600); err == nil {
					err = os.Symlink(outside, path)
				}
			case "outside-directory":
				err = os.Symlink(t.TempDir(), filepath.Join(dir, "external"))
			case "inside-directory":
				err = os.Symlink(dir, filepath.Join(root, "alias"))
			case "linked-src":
				err = os.Symlink(t.TempDir(), filepath.Join(root, "src"))
			}
			if err != nil {
				t.Fatal(err)
			}
			for _, collect := range []func(string, map[string]string) (sourceNoticeInventory, error){collectSDKOtherNotices, collectModuleNestedNotices} {
				if _, err := collect(root, map[string]string{}); err == nil {
					t.Fatal("unsafe evidence accepted")
				}
			}
			if kind == "linked-src" {
				if _, err := collectSDKSourceNotices(root, map[string]string{}); err == nil {
					t.Fatal("linked src accepted")
				}
			}
		})
	}
}

func TestActualSDKOtherNotices(t *testing.T) {
	notices := map[string]string{}
	r, err := collectSDKOtherNotices(runtime.GOROOT(), notices)
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range r.Files {
		if strings.HasPrefix(file.Name, "src/") || !strings.Contains(file.Name, "/") || digest([]byte(notices[file.SHA256])) != file.SHA256 {
			t.Fatal("wrong SDK scope or bytes")
		}
	}
	t.Logf("Go %s: %d other SDK notices, %d distinct texts", runtime.Version(), len(r.Files), len(notices))
}
