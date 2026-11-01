package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"unicode/utf8"
)

var errFrame = errors.New("invalid or oversized MCP frame")

// Reject ambiguous objects and excessive nesting before SDK or API decoding.
// Arrays are allowed within a message, but JSON-RPC batches are not this profile.
func validJSON(data []byte) bool {
	if !utf8.Valid(data) || len(bytes.TrimSpace(data)) == 0 || bytes.TrimSpace(data)[0] != '{' {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value func(int) bool
	value = func(depth int) bool {
		if depth > 32 {
			return false
		}
		token, err := decoder.Token()
		if err != nil {
			return false
		}
		switch token {
		case json.Delim('{'):
			keys := map[string]bool{}
			for decoder.More() {
				key, err := decoder.Token()
				text, ok := key.(string)
				if err != nil || !ok || keys[text] || !value(depth+1) {
					return false
				}
				keys[text] = true
			}
			end, err := decoder.Token()
			return err == nil && end == json.Delim('}')
		case json.Delim('['):
			for decoder.More() {
				if !value(depth + 1) {
					return false
				}
			}
			end, err := decoder.Token()
			return err == nil && end == json.Delim(']')
		default:
			_, delimiter := token.(json.Delim)
			return !delimiter
		}
	}
	if !value(0) {
		return false
	}
	if _, err := decoder.Token(); err != io.EOF {
		return false
	}
	// encoding/json replaces unpaired escaped surrogates. Refuse them instead
	// of silently changing parameter text or a request ID.
	for i := 0; i < len(data); i++ {
		if data[i] != '\\' {
			continue
		}
		i++
		if i >= len(data) || data[i] != 'u' {
			continue
		}
		if i+4 >= len(data) {
			return false
		}
		n, err := strconv.ParseUint(string(data[i+1:i+5]), 16, 16)
		if err != nil {
			return false
		}
		i += 4
		if n >= 0xd800 && n <= 0xdbff {
			if i+6 >= len(data) || data[i+1] != '\\' || data[i+2] != 'u' {
				return false
			}
			low, err := strconv.ParseUint(string(data[i+3:i+7]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			i += 6
		} else if n >= 0xdc00 && n <= 0xdfff {
			return false
		}
	}
	return true
}

func safeRequestID(data []byte) bool {
	var object map[string]json.RawMessage
	if json.Unmarshal(data, &object) != nil {
		return false
	}
	id, exists := object["id"]
	if !exists {
		return true
	}
	if len(id) > 1024 {
		return false
	}
	var text string
	if len(id) > 0 && id[0] == '"' && json.Unmarshal(id, &text) == nil {
		return len(text) <= 256
	}
	// The pinned SDK represents numeric request IDs as float64. Exact larger
	// IDs must be strings; reject an unsafe number before it can execute a tool.
	n, err := strconv.ParseInt(string(id), 10, 64)
	return err == nil && n >= -9007199254740991 && n <= 9007199254740991
}

type framedReader struct {
	source  io.ReadCloser
	scanner *bufio.Scanner
	pending []byte
}

func newFramedReader(source io.ReadCloser) *framedReader {
	scanner := bufio.NewScanner(source)
	scanner.Buffer(make([]byte, 4096), mcpFrameLimit+2)
	scanner.Split(func(data []byte, atEOF bool) (int, []byte, error) {
		if index := bytes.IndexByte(data, '\n'); index >= 0 {
			return index + 1, data[:index], nil
		}
		if atEOF && len(data) != 0 {
			return 0, nil, errFrame
		}
		return 0, nil, nil
	})
	return &framedReader{source: source, scanner: scanner}
}

func (r *framedReader) Read(buffer []byte) (int, error) {
	if len(buffer) == 0 {
		return 0, nil
	}
	if len(r.pending) == 0 {
		if !r.scanner.Scan() {
			if r.scanner.Err() != nil {
				return 0, errFrame
			}
			return 0, io.EOF
		}
		data := r.scanner.Bytes()
		if len(data) > mcpFrameLimit || !validJSON(data) || !safeRequestID(data) {
			return 0, errFrame
		}
		r.pending = append(append([]byte{}, data...), '\n')
	}
	n := copy(buffer, r.pending)
	r.pending = r.pending[n:]
	return n, nil
}

func (r *framedReader) Close() error { return r.source.Close() }

type framedWriter struct{ destination io.Writer }

func (w framedWriter) Write(data []byte) (int, error) {
	if len(data) > mcpFrameLimit || len(data) == 0 || data[len(data)-1] != '\n' || bytes.Count(data, []byte{'\n'}) != 1 || !validJSON(data) {
		return 0, errFrame
	}
	return w.destination.Write(data)
}

func (framedWriter) Close() error { return nil }
