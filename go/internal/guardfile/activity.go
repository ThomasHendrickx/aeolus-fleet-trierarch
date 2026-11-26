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
	"syscall"

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

// ReadToolCalls reads up to limit complete records after the last reported byte.
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
	for len(calls) < limit {
		if err := ctx.Err(); err != nil {
			return nil, offset, err
		}
		line, err := reader.ReadSlice('\n')
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, offset, fmt.Errorf("read tool call: %w", err)
		}
		var call guard.CallActivity
		if err := json.Unmarshal(line, &call); err != nil {
			return nil, offset, fmt.Errorf("decode tool call: %w", err)
		}
		calls = append(calls, call)
		next += int64(len(line))
	}
	return calls, next, nil
}
