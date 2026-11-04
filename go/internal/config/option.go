package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
)

// Names are the option's value names in their order, sorted when it has none that names them all.
func (o Option) Names() []string {
	if len(o.Order) == len(o.Values) && !slices.ContainsFunc(o.Order, func(name string) bool { _, ok := o.Values[name]; return !ok }) {
		return slices.Clone(o.Order)
	}
	return slices.Sorted(maps.Keys(o.Values))
}

// optionShape is an option as JSON holds it, its values read in order apart.
type optionShape struct {
	Values  json.RawMessage `json:"values"`
	Default string          `json:"default,omitempty"`
}

// UnmarshalJSON reads the option, keeping the order its values are written in, and refuses a key of another shape.
func (o *Option) UnmarshalJSON(text []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(text))
	decoder.DisallowUnknownFields()
	var shape optionShape
	if err := decoder.Decode(&shape); err != nil {
		return err
	}
	values := map[string][]string{}
	if err := json.Unmarshal(shape.Values, &values); err != nil {
		return err
	}
	order, err := keysInOrder(shape.Values)
	if err != nil {
		return err
	}
	*o = Option{Values: values, Default: shape.Default, Order: order}
	return nil
}

// MarshalJSON writes the option with its values in their order.
func (o Option) MarshalJSON() ([]byte, error) {
	var values bytes.Buffer
	values.WriteByte('{')
	for at, name := range o.Names() {
		if at > 0 {
			values.WriteByte(',')
		}
		key, err := json.Marshal(name)
		if err != nil {
			return nil, err
		}
		flags, err := json.Marshal(o.Values[name])
		if err != nil {
			return nil, err
		}
		values.Write(key)
		values.WriteByte(':')
		values.Write(flags)
	}
	values.WriteByte('}')
	return json.Marshal(optionShape{Values: values.Bytes(), Default: o.Default})
}

// keysInOrder are the keys of a JSON object in the order it holds them.
func keysInOrder(object json.RawMessage) ([]string, error) {
	decoder := json.NewDecoder(bytes.NewReader(object))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, fmt.Errorf("values are no JSON object")
	}
	var keys []string
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, _ := token.(string)
		keys = append(keys, key)
		var skipped json.RawMessage
		if err := decoder.Decode(&skipped); err != nil {
			return nil, err
		}
	}
	return keys, nil
}
