package shipview

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"io/fs"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/eventlog"
)

// activityTails bounds the amount read from either retained file.
func activityTails(ctx context.Context, events eventlog.Files) (eventlog.Files, error) {
	tails := make(eventlog.Files, 0, len(events))
	for _, file := range events {
		tail, err := activityTail(ctx, file)
		if err != nil {
			return nil, err
		}
		tails = append(tails, tail)
	}
	return tails, nil
}

// activityTail leaves the event reader its last 200 nonempty lines while avoiding
// a full history scan on each live refresh. Non-seekable test files remain readable.
func activityTail(ctx context.Context, file fs.File) (fs.File, error) {
	random, ok := file.(io.ReaderAt)
	if !ok {
		return file, nil
	}
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("stat activity tail: %w", err)
	}
	remaining := info.Size()
	var tail []byte
	for remaining > 0 {
		if err := ctx.Err(); err != nil {
			return nil, fmt.Errorf("read activity tail: %w", err)
		}
		size := min(remaining, 64*1024)
		remaining -= size
		block := make([]byte, int(size))
		if _, err := random.ReadAt(block, remaining); err != nil {
			return nil, fmt.Errorf("read activity tail: %w", err)
		}
		tail = append(block, tail...)
		lines := bytes.Split(tail, []byte{'\n'})
		nonempty := 0
		for i := len(lines) - 1; i >= 0; i-- {
			if len(lines[i]) == 0 {
				continue
			}
			nonempty++
			// The first line may start in the previous block.
			if nonempty == lastLines && (i > 0 || remaining == 0) {
				return activityInput{File: file, input: bytes.NewReader(bytes.Join(lines[i:], []byte{'\n'}))}, nil
			}
		}
	}
	return activityInput{File: file, input: bytes.NewReader(tail)}, nil
}

type activityInput struct {
	fs.File
	input io.Reader
}

func (f activityInput) Read(p []byte) (int, error) { return f.input.Read(p) }
