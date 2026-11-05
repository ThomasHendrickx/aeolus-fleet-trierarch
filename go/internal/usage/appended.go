package usage

import (
	"bytes"
	"io"
	"os"
	"strings"
)

// Lines are the lines a file gained since the last read, each written whole; IsFromStart when the file was read from its start, as on the first read or after it shrank.
type Lines struct {
	Lines       []string
	IsFromStart bool
}

// AppendedLines reads the lines a growing file appended since its last read, so a transcript of many megabytes is not read whole every few minutes. A line not ended yet waits for the next read; a file that shrank is read again from its start. Its zero value has read nothing yet.
type AppendedLines struct {
	offsets map[string]int64
}

// Read is what the file gained since the last read.
func (a *AppendedLines) Read(path string) (Lines, error) {
	file, err := os.Open(path)
	if err != nil {
		return Lines{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return Lines{}, err
	}
	if a.offsets == nil {
		a.offsets = map[string]int64{}
	}
	start := a.offsets[path]
	if start > info.Size() {
		start = 0
	}
	buffer := make([]byte, info.Size()-start)
	if _, err := file.ReadAt(buffer, start); err != nil && err != io.EOF {
		return Lines{}, err
	}
	end := bytes.LastIndexByte(buffer, '\n')
	a.offsets[path] = start + int64(end) + 1
	read := Lines{IsFromStart: start == 0}
	if end > 0 {
		read.Lines = strings.Split(string(buffer[:end]), "\n")
	}
	return read, nil
}
