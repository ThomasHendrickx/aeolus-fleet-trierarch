package hold

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

type workingTime struct {
	Elapsed time.Duration `json:"elapsedNanoseconds"`
	Since   time.Time     `json:"workingSince,omitzero"`
	IsOpen  bool          `json:"isTurnOpen,omitempty"`
	Unknown bool          `json:"unknown,omitempty"`
}

// WorkingTimePath is the working time record in the folder that lives as long as the crew.
func WorkingTimePath(shipFolder string) string {
	if shipFolder == "" {
		return ""
	}
	return filepath.Join(shipFolder, "working-time.json")
}

// ReadWorkingTime reads the time its hold observed the ship working. An open turn whose
// hold vanished has no reliable end, so its total is unknown.
func ReadWorkingTime(path string, now time.Time, isRunning bool) (time.Duration, bool) {
	var reading workingTime
	data, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(data, &reading) != nil || reading.Elapsed < 0 || reading.Unknown {
		return 0, false
	}
	if reading.IsOpen && !isRunning {
		return 0, false
	}
	if !reading.Since.IsZero() {
		return reading.Elapsed + max(0, now.Sub(reading.Since)), true
	}
	return reading.Elapsed, true
}

// workingClock is owned by the hold's mutex. The file survives ordinary hold replacement.
// Only a fresh crew or a complete earlier reading can start a known total.
type workingClock struct {
	path    string
	now     func() time.Time
	reading workingTime
	waits   map[string]struct{}
}

func openWorkingClock(path string, now func() time.Time) workingClock {
	clock := workingClock{path: path, now: now}
	if path == "" {
		return clock
	}
	if clock.now == nil {
		clock.now = time.Now
	}
	data, err := os.ReadFile(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		clock.save()
	case err != nil || json.Unmarshal(data, &clock.reading) != nil || clock.reading.Elapsed < 0 || clock.reading.Unknown:
		clock.path = ""
	case clock.reading.IsOpen:
		clock.reading = workingTime{Unknown: true}
		clock.save()
		clock.path = ""
	}
	return clock
}

func (c *workingClock) start() {
	if c.path == "" || c.reading.IsOpen {
		return
	}
	c.reading.IsOpen = true
	c.reading.Since = c.now()
	c.save()
}

func (c *workingClock) end() {
	if c.path == "" || !c.reading.IsOpen {
		return
	}
	c.stopWorking()
	c.reading.IsOpen = false
	c.waits = nil
	c.save()
}

func (c *workingClock) wait(id string) {
	if c.path == "" || !c.reading.IsOpen || id == "" {
		return
	}
	if len(c.waits) == 0 {
		c.waits = make(map[string]struct{})
		c.stopWorking()
		c.save()
	}
	c.waits[id] = struct{}{}
}

func (c *workingClock) resume(id string) {
	if _, ok := c.waits[id]; !ok {
		return
	}
	delete(c.waits, id)
	if c.path != "" && len(c.waits) == 0 {
		c.reading.Since = c.now()
		c.save()
	}
}

func (c *workingClock) usageWindow(status string) {
	const waitID = "usage-limit"
	switch status {
	case "rejected":
		c.wait(waitID)
	case "allowed", "allowed_warning":
		c.resume(waitID)
	}
}

func (c *workingClock) stopWorking() {
	if !c.reading.Since.IsZero() {
		c.reading.Elapsed += max(0, c.now().Sub(c.reading.Since))
		c.reading.Since = time.Time{}
	}
}

func (c *workingClock) save() {
	if err := c.write(); err != nil {
		_ = os.Remove(c.path)
		c.path = ""
	}
}

func (c *workingClock) write() error {
	file, err := os.CreateTemp(filepath.Dir(c.path), ".working-time-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	writeErr := json.NewEncoder(file).Encode(c.reading)
	if err := errors.Join(writeErr, file.Close()); err != nil {
		return err
	}
	return os.Rename(file.Name(), c.path)
}
