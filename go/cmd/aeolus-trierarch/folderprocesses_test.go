package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

func TestTheProcessesInAFolderAreStoppedOnTheHostAndInContainersOnlyOnceNoContainerWorksInIt(t *testing.T) {
	folder := t.TempDir()
	// A docker-style binary that lists one running container for any folder.
	binary := filepath.Join(t.TempDir(), "runtime")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\n[ \"$1\" = ps ] && echo 'trierarch-shp_01m6ny0nbtx4jc6hf1pqr2fx2f running'\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	onTheHost, hostErr := folderProcessesOf(nil).StopIn(folder)
	_, containerErr := folderProcessesOf(&config.Runtime{Kind: "container", Binary: binary}).StopIn(folder)

	if hostErr != nil || onTheHost != 0 {
		t.Errorf("on the host StopIn(%s) = %d, %v; want 0, none", folder, onTheHost, hostErr)
	}
	if containerErr == nil || !strings.Contains(containerErr.Error(), "a container works in") {
		t.Errorf("in containers StopIn(%s) = %v; want it left for the next pass", folder, containerErr)
	}
}
