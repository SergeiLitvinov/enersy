// backend-go/main.go
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
)

type Response struct {
	Result interface{} `json:"result,omitempty"`
	Error  string      `json:"error,omitempty"`
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

	req, _ := http.NewRequest("POST", "http://python-service:8000/matrix-multiply", bytes.NewReader(jsonData))
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("Python request failed: %v", err)
		sendError(w, "Python service unreachable", http.StatusServiceUnavailable)
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	w.Header().Set("Content-Type", "application/json")
	w.Write(body)
}

func handleJuliaSolve(w http.ResponseWriter, r *http.Request) {
	var input struct {
		A [][]float64 `json:"A"`
		b []float64   `json:"b"`
	}

	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		sendError(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	jsonData, _ := json.Marshal(input)

	req, _ := http.NewRequest("POST", "http://julia-service:8001/solve", bytes.NewReader(jsonData))
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("Julia request failed: %v", err)
		sendError(w, "Julia service unreachable", http.StatusServiceUnavailable)
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	w.Header().Set("Content-Type", "application/json")
	w.Write(body)
}

func sendError(w http.ResponseWriter, message string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(Response{Error: message})
}

func main() {
	http.HandleFunc("/python/multiply", handlePythonMultiply)
	http.HandleFunc("/julia/solve", handleJuliaSolve)

	fmt.Println("Go API server starting on :8080...")
	log.Fatal(http.ListenAndServe(":8080", nil))
}