package config

import (
	"encoding/json"
	"maps"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// schemaNode is the part of the configuration's JSON Schema a Go type is held to.
type schemaNode struct {
	Type                 string                 `json:"type"`
	Properties           map[string]*schemaNode `json:"properties"`
	Required             []string               `json:"required"`
	AdditionalProperties json.RawMessage        `json:"additionalProperties"`
	Items                *schemaNode            `json:"items"`
	OneOf                []*schemaNode          `json:"oneOf"`
}

// jsonField is a struct field as encoding/json reads it: its key, and whether it may be left out.
type jsonField struct {
	key        string
	isOptional bool
	field      reflect.StructField
}

func jsonFields(t reflect.Type) map[string]jsonField {
	fields := map[string]jsonField{}
	for field := range t.Fields() {
		tag, ok := field.Tag.Lookup("json")
		if !ok || tag == "-" {
			continue
		}
		key, options, _ := strings.Cut(tag, ",")
		fields[key] = jsonField{key: key, isOptional: strings.Contains(options, "omitempty") || strings.Contains(options, "omitzero"), field: field}
	}
	return fields
}

// matchShape says how the Go type differs from the schema at the path, nothing when it does not.
func matchShape(path string, node *schemaNode, t reflect.Type) []string {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if len(node.OneOf) > 0 {
		// One Go struct holds every branch: each branch's keys are its fields, required where every branch requires them.
		union := &schemaNode{Type: "object", Properties: map[string]*schemaNode{}}
		for _, branch := range node.OneOf {
			maps.Copy(union.Properties, branch.Properties)
		}
		for key := range union.Properties {
			if slices.IndexFunc(node.OneOf, func(branch *schemaNode) bool { return !slices.Contains(branch.Required, key) }) == -1 {
				union.Required = append(union.Required, key)
			}
		}
		return matchShape(path, union, t)
	}
	switch node.Type {
	case "string":
		return kindIs(path, t, reflect.String)
	case "integer":
		return kindIs(path, t, reflect.Int)
	case "number":
		return kindIs(path, t, reflect.Float64)
	case "array":
		if t.Kind() != reflect.Slice {
			return []string{path + ": the schema has an array, Go has " + t.String()}
		}
		return matchShape(path+"[]", node.Items, t.Elem())
	case "object":
		if node.Properties == nil {
			if t.Kind() != reflect.Map || t.Key().Kind() != reflect.String {
				return []string{path + ": the schema has a record, Go has " + t.String()}
			}
			var value schemaNode
			if err := json.Unmarshal(node.AdditionalProperties, &value); err != nil {
				return []string{path + ": the record's values have no schema"}
			}
			return matchShape(path+"{}", &value, t.Elem())
		}
		if t.Kind() != reflect.Struct {
			return []string{path + ": the schema has an object, Go has " + t.String()}
		}
		var differences []string
		fields := jsonFields(t)
		for _, key := range slices.Sorted(maps.Keys(node.Properties)) {
			field, ok := fields[key]
			if !ok {
				differences = append(differences, path+"."+key+": in the schema, not in Go")
				continue
			}
			if isRequired := slices.Contains(node.Required, key); isRequired == field.isOptional {
				differences = append(differences, path+"."+key+": required in one, optional in the other")
			}
			differences = append(differences, matchShape(path+"."+key, node.Properties[key], field.field.Type)...)
		}
		for _, key := range slices.Sorted(maps.Keys(fields)) {
			if _, ok := node.Properties[key]; !ok {
				differences = append(differences, path+"."+key+": in Go, not in the schema")
			}
		}
		return differences
	}
	return []string{path + ": the schema's type " + node.Type + " has no Go type"}
}

func kindIs(path string, t reflect.Type, kind reflect.Kind) []string {
	if t.Kind() != kind {
		return []string{path + ": the schema has " + kind.String() + ", Go has " + t.String()}
	}
	return nil
}

func TestTheConfigurationTypesHaveTheShapeOfItsJSONSchema(t *testing.T) {
	var schema schemaNode
	if err := json.Unmarshal(Schema, &schema); err != nil {
		t.Fatalf("the embedded schema is no JSON: %v", err)
	}

	differences := matchShape("configuration", &schema, reflect.TypeFor[Configuration]())

	if len(differences) > 0 {
		t.Errorf("the configuration types drifted from config.schema.json:\n%s", strings.Join(differences, "\n"))
	}
}

func TestTheShapeCheckFindsAKeyTheGoTypesLack(t *testing.T) {
	var schema schemaNode
	if err := json.Unmarshal([]byte(`{"type":"object","properties":{"caps":{"type":"integer"},"newKey":{"type":"string"}},"required":["caps"]}`), &schema); err != nil {
		t.Fatal(err)
	}
	type lacking struct {
		Caps int `json:"caps"`
	}

	differences := matchShape("configuration", &schema, reflect.TypeFor[lacking]())

	if !slices.Equal(differences, []string{"configuration.newKey: in the schema, not in Go"}) {
		t.Errorf("found %q", differences)
	}
}
