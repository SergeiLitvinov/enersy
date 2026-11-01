package main

import (
	"bytes"
	"io"
	"strings"
	"testing"
)

func TestProtocolFrames(t *testing.T) {
	for _, input := range []string{
		`{"jsonrpc":"2.0","id":"9007199254740993","method":"ping"}`,
		`{"id":9007199254740991,"params":{"text":"\ud83d\ude00"}}`,
		`{"params":{"text":"\\ud800"}}`,
	} {
		r := newFramedReader(io.NopCloser(strings.NewReader(input + "\n")))
		got, err := io.ReadAll(r)
		if err != nil || string(got) != input+"\n" {
			t.Fatalf("valid frame changed: %q, %v", got, err)
		}
	}
	for _, input := range []string{
		`{"id":9007199254740992}` + "\n", `{"id":1e3}` + "\n", `{"id":null}` + "\n",
		`{"id":1,"id":2}` + "\n", `{"params":{"a":1,"\u0061":2}}` + "\n",
		`{"params":{"text":"\ud800"}}` + "\n", `{"params":{"text":"\udc00"}}` + "\n",
		"{\"text\":\"\xff\"}\n", "[]\n", "{}{}\n", "{}", "\n",
		`{"a":` + strings.Repeat("[", 34) + "0" + strings.Repeat("]", 34) + "}\n",
		`{"a":"` + strings.Repeat("x", mcpFrameLimit) + "\"}\n",
	} {
		r := newFramedReader(io.NopCloser(strings.NewReader(input)))
		if _, err := io.ReadAll(r); err == nil {
			t.Fatalf("invalid frame accepted: %.80q", input)
		}
	}
	var out bytes.Buffer
	w := framedWriter{&out}
	if _, err := w.Write([]byte("{}\n{}\n")); err == nil || out.Len() != 0 {
		t.Fatal("writer accepted multiple frames")
	}
	if _, err := w.Write([]byte("{}\n")); err != nil || out.String() != "{}\n" {
		t.Fatal("writer changed frame", err)
	}
}
