package main

import "net/http"

// Public worker metadata only: no equipment, project or user data is returned.
func handleModelDefinitions(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	proxyJulia(w, r, "/model-definitions", nil)
}
