package detection

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"time"
)

// File is the detected file, `~/.aeolus/trierarch/detected.json`, in the shape today's trierarch writes it, so either reads what the other wrote. A file that is missing or does not fit holds nothing, so detection runs again.
type File struct {
	Path string
}

// Load reads what was detected; nothing when the file is missing or does not fit.
func (f File) Load() Detected {
	text, err := os.ReadFile(f.Path)
	if err != nil {
		return Detected{}
	}
	decoder := json.NewDecoder(bytes.NewReader(text))
	decoder.DisallowUnknownFields()
	var detected Detected
	if decoder.Decode(&detected) != nil || detected == nil || !fits(detected) {
		return Detected{}
	}
	return detected
}

// fits is whether each harness's detection has the shape the file holds: a version, times as times, and refused ids that name a model.
func fits(detected Detected) bool {
	for _, found := range detected {
		times := []string{found.DetectedAt}
		if found.ConfirmedAt != nil {
			times = append(times, *found.ConfirmedAt)
		}
		for _, each := range found.Refused {
			if each.ID == "" {
				return false
			}
			times = append(times, each.At)
		}
		if found.Version == "" || found.Options == nil || slices.Contains(found.PermissionModes, "") || slices.ContainsFunc(times, isNoTime) {
			return false
		}
	}
	return true
}

// isNoTime is whether the text is no time as JSON writes one.
func isNoTime(text string) bool {
	_, err := time.Parse(time.RFC3339Nano, text)
	return err != nil
}

// Save writes what was detected whole, as today's trierarch does: indented by two, with a last newline.
func (f File) Save(detected Detected) error {
	if err := os.MkdirAll(filepath.Dir(f.Path), 0o700); err != nil {
		return err
	}
	text, err := json.MarshalIndent(detected, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(f.Path, append(text, '\n'), 0o644)
}
