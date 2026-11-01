package main

import (
	"context"
	"database/sql"
	"strconv"
)

// applicationService is transport independent. Credentials are supplied by the
// trusted adapter, never by a model's command arguments. It holds no active
// project/session state: every call resolves access inside its own snapshot.
type applicationService struct{ database *sql.DB }

type readSchemeCommand struct {
	ProjectID        int64
	SchemeID         int
	ExpectedIdentity *applicationIdentity `json:"-"`
}

type snapshotID interface{ int | string }

// Generic IDs preserve the existing anonymous numeric-ID and private string-ID
// contracts without untyped maps or JSON serialization as an internal adapter.
type schemeGraph[ID snapshotID] struct {
	ID               ID                             `json:"id"`
	ProjectID        string                         `json:"projectId,omitempty"`
	Name             string                         `json:"name"`
	Description      string                         `json:"description"`
	CreatedAt        *string                        `json:"created_at"`
	UpdatedAt        *string                        `json:"updated_at"`
	TopologyRevision string                         `json:"topologyRevision"`
	Components       []schemeComponentSnapshot[ID]  `json:"components"`
	Connections      []schemeConnectionSnapshot[ID] `json:"connections"`
}

type schemeComponentSnapshot[ID snapshotID] struct {
	ID                     ID                        `json:"id"`
	TypeID                 ID                        `json:"typeId"`
	Type                   string                    `json:"type"`
	Name                   string                    `json:"name"`
	X                      float64                   `json:"x"`
	Y                      float64                   `json:"y"`
	Rotation               int                       `json:"rotation"`
	Revision               string                    `json:"revision"`
	EquipmentModelID       *ID                       `json:"equipmentModelId"`
	Params                 map[string]string         `json:"params"`
	DeclaredParameterUnits *parameterUnitDeclaration `json:"declaredParameterUnits,omitempty"`
	// nil omits this field for anonymous diagrams; pointer to nil emits the
	// existing explicit null for project equipment without a passport binding.
	ProjectPassportVersionID **string `json:"projectPassportVersionId,omitempty"`
}

type schemeConnectionSnapshot[ID snapshotID] struct {
	ID               ID       `json:"id"`
	From             ID       `json:"from"`
	To               ID       `json:"to"`
	FromPort         string   `json:"fromPort"`
	ToPort           string   `json:"toPort"`
	ValidationErrors []string `json:"validationErrors"`
}

// ReadScheme is the first shared application operation. It cannot fall back to
// anonymous diagrams when a caller omits its project or provides invalid IDs.
// A returned graph is an observation, not a grant for a subsequent mutation.
func (service applicationService) ReadScheme(ctx context.Context, token string, command readSchemeCommand) (schemeGraph[string], error) {
	if command.ProjectID <= 0 || command.SchemeID <= 0 {
		return schemeGraph[string]{}, errProjectUnavailable
	}
	graph, err := readSchemeSnapshot(ctx, service.database, command.SchemeID, command.ProjectID, token, command.ExpectedIdentity)
	if err != nil {
		return schemeGraph[string]{}, err
	}
	return stringifySchemeGraph(graph), nil
}

func stringifySchemeGraph(graph schemeGraph[int]) schemeGraph[string] {
	result := schemeGraph[string]{
		ID: strconv.Itoa(graph.ID), ProjectID: graph.ProjectID, Name: graph.Name, Description: graph.Description,
		CreatedAt: graph.CreatedAt, UpdatedAt: graph.UpdatedAt, TopologyRevision: graph.TopologyRevision,
		Components:  make([]schemeComponentSnapshot[string], 0, len(graph.Components)),
		Connections: make([]schemeConnectionSnapshot[string], 0, len(graph.Connections)),
	}
	for _, item := range graph.Components {
		var model *string
		if item.EquipmentModelID != nil {
			value := strconv.Itoa(*item.EquipmentModelID)
			model = &value
		}
		result.Components = append(result.Components, schemeComponentSnapshot[string]{
			ID: strconv.Itoa(item.ID), TypeID: strconv.Itoa(item.TypeID), Type: item.Type, Name: item.Name,
			X: item.X, Y: item.Y, Rotation: item.Rotation, Revision: item.Revision, Params: item.Params,
			EquipmentModelID: model, DeclaredParameterUnits: item.DeclaredParameterUnits,
			ProjectPassportVersionID: item.ProjectPassportVersionID,
		})
	}
	for _, item := range graph.Connections {
		result.Connections = append(result.Connections, schemeConnectionSnapshot[string]{
			ID: strconv.Itoa(item.ID), From: strconv.Itoa(item.From), To: strconv.Itoa(item.To),
			FromPort: item.FromPort, ToPort: item.ToPort, ValidationErrors: item.ValidationErrors,
		})
	}
	return result
}
