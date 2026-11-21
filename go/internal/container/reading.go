package container

import (
	"context"
	"fmt"
	"os/exec"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/folderprocess"
)

// Processes reads a container's pids, elapsed times and whole commands for masking.
func (r Runtime) Processes(ctx context.Context, shipID string, now time.Time) ([]folderprocess.Process, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	args := []string{"top", containerName(shipID), "-ww", "-eo", "pid,etime,args"}
	var text string
	var err error
	if r.Run != nil {
		text, err = r.Run(args...)
	} else {
		var data []byte
		data, err = exec.CommandContext(ctx, r.Binary, args...).Output()
		text = string(data)
	}
	if err != nil {
		return nil, fmt.Errorf("read container processes: %w", err)
	}
	return folderprocess.Commands(text, now)
}
