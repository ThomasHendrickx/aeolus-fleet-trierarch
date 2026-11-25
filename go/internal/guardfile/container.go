package guardfile

import (
	"context"
	"path"
	"path/filepath"
	"strings"
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
