package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestStudySourceDigestCanonical(t *testing.T) {
	components := []calculationComponent{{ID: 2, Revision: 9007199254740993}, {ID: 10, Revision: 1}}
	const expected = "v1:66bb33f9f6ab4baf8ef55df95d59179f1d4b578b35824c3a7defe5542fb227c0"
	// Independently hashed UTF-8 bytes using .NET SHA256, not this serializer.
	if got := studySourceDigest(7, components); got != expected {
		t.Fatal(got)
	}
	if studySourceDigest(8, components) == expected {
		t.Fatal("scheme not bound")
	}
	components[0].Revision++
	if studySourceDigest(7, components) == expected {
		t.Fatal("revision rounded")
	}
	for _, bad := range []string{"", "v2:" + strings.Repeat("a", 64), "v1:" + strings.Repeat("A", 64), expected + "\n"} {
		if studySourceDigestPattern.MatchString(bad) {
			t.Fatalf("accepted %q", bad)
		}
	}
	large := make([]calculationComponent, 100000)
	for i := range large {
		large[i] = calculationComponent{ID: i + 1, Revision: 1}
	}
	body, err := json.Marshal(map[string]string{"sourceDigest": studySourceDigest(7, large)})
	if err != nil || len(body) > 100 {
		t.Fatalf("noncompact digest: %d %v", len(body), err)
	}
	source := []studySourceRevision{}
	digest := expected
	_, err = (projectStore{}).saveStudySource(context.Background(), "", 1, 7, 0, 0, 0, studyCommand(900), studyDocument{}, &source, &digest)
	if !errors.Is(err, errStudyInput) {
		t.Fatal("ambiguous list and digest accepted", err)
	}
}
