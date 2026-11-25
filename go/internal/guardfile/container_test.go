package guardfile

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// aContainersView is a container's view of a home and a workspace kept in two folders of the host, at /home/ubuntu and /work.
func aContainersView(t *testing.T) (ContainerLinks, string, string) {
	t.Helper()
	host := t.TempDir()
	home, workspace := filepath.Join(host, "ship", "home"), filepath.Join(host, "ship", "repositories")
	for _, folder := range []string{filepath.Join(home, ".claude"), workspace} {
		if err := os.MkdirAll(folder, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return ContainerLinks{Mounts: []Mount{{Host: workspace, Container: "/work"}, {Host: home, Container: "/home/ubuntu"}}}, home, workspace
}

func TestALinkInAMountedFolderIsReadFromTheHostAndNamesItsTargetAsTheContainerSeesIt(t *testing.T) {
	links, _, workspace := aContainersView(t)
	if err := os.Symlink("/home/ubuntu/.claude", filepath.Join(workspace, "settings")); err != nil {
		t.Fatal(err)
	}

	target, isLink, err := links.Readlink(context.Background(), "/work/settings")

	if err != nil || !isLink || target != "/home/ubuntu/.claude" {
		t.Fatalf("Readlink(/work/settings) = %q, %t, %v, want the link to /home/ubuntu/.claude", target, isLink, err)
	}
}

func TestAPathIsReadInTheFolderMountedAtItsLongestPrefix(t *testing.T) {
	links, home, _ := aContainersView(t)
	inner := filepath.Join(t.TempDir(), "cache")
	if err := os.MkdirAll(inner, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/work", filepath.Join(inner, "here")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/elsewhere", filepath.Join(home, "here")); err != nil {
		t.Fatal(err)
	}
	links.Mounts = append(links.Mounts, Mount{Host: inner, Container: "/home/ubuntu/.cache"})

	target, isLink, err := links.Readlink(context.Background(), "/home/ubuntu/.cache/here")

	if err != nil || !isLink || target != "/work" {
		t.Fatalf("Readlink(/home/ubuntu/.cache/here) = %q, %t, %v, want the link of the inner mount to /work", target, isLink, err)
	}
}

func TestAPathNoFolderIsMountedAtIsNoLink(t *testing.T) {
	links, home, _ := aContainersView(t)
	if err := os.Symlink("/work", filepath.Join(home, "x")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/", "/home", "/etc/passwd", "/home/ubuntu2/x", filepath.Join(home, "x")} {
		target, isLink, err := links.Readlink(context.Background(), path)

		if err != nil || isLink {
			t.Errorf("Readlink(%s) = %q, %t, %v, want no link: nothing of the host is mounted there", path, target, isLink, err)
		}
	}
}

func TestTheMountPointItselfIsReadFromTheHost(t *testing.T) {
	links, _, _ := aContainersView(t)

	_, isLink, err := links.Readlink(context.Background(), "/home/ubuntu")

	if err != nil || isLink {
		t.Fatalf("Readlink(/home/ubuntu) = %t, %v, want the mounted folder, no link", isLink, err)
	}
}
