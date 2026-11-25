package guardfile

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guard"
)

// Mount is a folder of the host a session's container sees, at its path in the container.
type Mount struct {
	Host      string
	Container string
}

// ContainerLinks reads the symbolic links of a container session's file system as its container sees it (#631): a path in a mounted
// folder is read at its place on the host, the longest mount first, and a link's target is kept as written, a path in the container.
// A path under no mount is the image's read-only root, which no session can make a link in, so it is no link.
type ContainerLinks struct {
	Mounts []Mount
}

// Readlink is the link's target at the container's path, or false when the path is no link, does not exist or is under no mount.
func (c ContainerLinks) Readlink(ctx context.Context, containerPath string) (string, bool, error) {
	host, ok := c.host(path.Clean(containerPath))
	if !ok {
		return "", false, ctx.Err()
	}
	return Links{}.Readlink(ctx, host)
}

// host is the place on the host of the container's path, by the longest mount whose path holds it.
func (c ContainerLinks) host(containerPath string) (string, bool) {
	found, longest := "", -1
	for _, mount := range c.Mounts {
		at := path.Clean(mount.Container)
		rest, ok := strings.CutPrefix(containerPath, at)
		if !ok || (rest != "" && !strings.HasPrefix(rest, "/") && at != "/") || len(at) <= longest {
			continue
		}
		found, longest = filepath.Join(mount.Host, filepath.FromSlash(rest)), len(at)
	}
	return found, longest >= 0
}

// ErrUnmounted is a container's path that resolves under no folder it mounts: the image's, which the host cannot read.
var ErrUnmounted = errors.New("under no folder the container mounts")

// ReadFile is the text of the file at the container's path as its container reads it: every link in the path followed as the container
// sees it, the file read at its place on the host. A path that resolves under no mount is ErrUnmounted.
func (c ContainerLinks) ReadFile(ctx context.Context, containerPath string) ([]byte, error) {
	resolved, err := guard.Resolve(ctx, c, path.Clean(containerPath))
	if err != nil {
		return nil, fmt.Errorf("resolve %s in the container: %w", containerPath, err)
	}
	host, ok := c.host(resolved)
	if !ok {
		return nil, fmt.Errorf("%s resolves to %s, %w", containerPath, resolved, ErrUnmounted)
	}
	return Within(ctx, func() ([]byte, error) { return os.ReadFile(host) })
}
