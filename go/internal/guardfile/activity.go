package guardfile

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unicode"
	"unicode/utf16"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guard"
)

const toolCallsFile = "tool-calls.jsonl"

// ToolCalls keeps the metadata of every guard check in the ship's guard folder.
type ToolCalls struct {
	Guards string
	ShipID string
}

// Append records the call at the end of its ship's activity file.
func (t ToolCalls) Append(ctx context.Context, call guard.CallActivity) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := appendRecord(t.Guards, t.ShipID, toolCallsFile, call); err != nil {
		return fmt.Errorf("record tool call: %w", err)
	}
	return nil
}

// ReadToolCalls reads up to limit usable records and skips bad complete lines after the last reported byte.
func (s Store) ReadToolCalls(ctx context.Context, shipID string, offset int64, limit int) ([]guard.CallActivity, int64, error) {
	if !crew.IsShipID(shipID) {
		return nil, offset, errors.New("invalid guard activity ship id")
	}
	file, err := os.OpenFile(filepath.Join(Folder(s.Guards, shipID), toolCallsFile), os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if errors.Is(err, os.ErrNotExist) {
		return nil, offset, nil
	}
	if err != nil {
		return nil, offset, fmt.Errorf("open tool calls: %w", err)
	}
	defer file.Close()
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return nil, offset, fmt.Errorf("seek tool calls: %w", err)
	}
	reader := bufio.NewReaderSize(file, 64*1024)
	var calls []guard.CallActivity
	next := offset
	var oversizedBytes int64
	for len(calls) < limit {
		if err := ctx.Err(); err != nil {
			return nil, offset, err
		}
		line, err := reader.ReadSlice('\n')
		if errors.Is(err, io.EOF) {
			break
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			oversizedBytes += int64(len(line))
			continue
		}
		if err != nil {
			return nil, offset, fmt.Errorf("read tool call: %w", err)
		}
		next += oversizedBytes + int64(len(line))
		if oversizedBytes != 0 {
			oversizedBytes = 0
			continue
		}
		var call guard.CallActivity
		if err := json.Unmarshal(line, &call); err != nil {
			continue
		}
		if call.At.IsZero() || call.At.UTC().Year() < 0 || call.At.UTC().Year() > 9999 ||
			(call.Result != "allowed" && call.Result != "refused") {
			continue
		}
		call.Tool = activityToolName(call.Tool)
		call.Reason = strings.TrimFunc(call.Reason, activitySpace)
		calls = append(calls, call)
	}
	return calls, next, nil
}

// activityToolName applies the fleet schema's tool length limit in UTF-16 code units.
func activityToolName(tool string) string {
	const maxToolLength = 100
	tool = strings.TrimFunc(tool, activitySpace)
	length := 0
	for index, character := range tool {
		length += utf16.RuneLen(character)
		if length > maxToolLength {
			return tool[:index]
		}
	}
	return tool
}

func activitySpace(character rune) bool {
	return unicode.IsSpace(character) || character == '\uFEFF'
}
