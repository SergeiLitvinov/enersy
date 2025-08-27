package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
)

type Response struct {
	Result interface{} `json:"result,omitempty"`
	Error  string      `json:"error,omitempty"`
}

// CORS middleware
func enableCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		next(w, r)
	}
}

func handlePythonMultiply(w http.ResponseWriter, r *http.Request) {
	var input struct {
		A [][]float64 `json:"A"`
		B [][]float64 `json:"B"`
	}

	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		sendError(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	jsonData, _ := json.Marshal(input)

	req, _ := http.NewRequest("POST", "http://python-compute:8000/matrix-multiply", bytes.NewReader(jsonData))
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		sendError(w, "Python service unreachable", http.StatusServiceUnavailable)
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	w.Header().Set("Content-Type", "application/json")
	w.Write(body)
}

func handleJuliaSolve(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		sendError(w, "Failed to read request body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	var input struct {
		A [][]float64 `json:"A"`
		B []float64   `json:"b"`
	}

	if err := json.Unmarshal(body, &input); err != nil {
		sendError(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	jsonData, err := json.Marshal(map[string]interface{}{
		"A": input.A,
		"b": input.B,
	})
	if err != nil {
		sendError(w, "Internal error", http.StatusInternalServerError)
		return
	}

	req, err := http.NewRequest("POST", "http://julia-compute:8001/solve", bytes.NewReader(jsonData))
	if err != nil {
		sendError(w, "Request failed", http.StatusInternalServerError)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		sendError(w, "Julia service unreachable", http.StatusServiceUnavailable)
		return
	}
	defer resp.Body.Close()

	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		sendError(w, "Read error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(responseBody)
}

func sendError(w http.ResponseWriter, message string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(Response{Error: message})
}

func main() {
	http.HandleFunc("/python/multiply", enableCORS(handlePythonMultiply))
	http.HandleFunc("/julia/solve", enableCORS(handleJuliaSolve))

	http.ListenAndServe(":8080", nil)
}