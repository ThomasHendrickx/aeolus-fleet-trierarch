// Package trust reads which configured places each harness trusts (#381), from
// the harness's own files each time, so a place is offered only while every
// offered harness would start a session there without asking.
package trust

import (
	"slices"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

// Places are the names of the repositories and folders a harness trusts.
type Places struct {
	Repositories []string
	Folders      []string
}

// Of is what each configured harness trusts: a place is trusted when its path is among the folders the harness's reader names. A harness with no reader trusts nothing.
func Of(configuration config.Configuration, readers map[string]func() map[string]bool) map[string]Places {
	trusted := map[string]Places{}
	for harness := range configuration.Harnesses {
		folders := map[string]bool{}
		if read, ok := readers[harness]; ok {
			folders = read()
		}
		places := Places{Repositories: []string{}, Folders: []string{}}
		for name, repository := range configuration.Repositories {
			if folders[repository.Path] {
				places.Repositories = append(places.Repositories, name)
			}
		}
		for name, folder := range configuration.Folders {
			if folders[folder.Path] {
				places.Folders = append(places.Folders, name)
			}
		}
		slices.Sort(places.Repositories)
		slices.Sort(places.Folders)
		trusted[harness] = places
	}
	return trusted
}

// Everything is a reader that names every configured place: Copilot asks about no folder in `copilot -p`, so it trusts them all.
func Everything(configuration config.Configuration) func() map[string]bool {
	return func() map[string]bool {
		folders := map[string]bool{}
		for _, repository := range configuration.Repositories {
			folders[repository.Path] = true
		}
		for _, folder := range configuration.Folders {
			folders[folder.Path] = true
		}
		return folders
	}
}
