package plugin

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTheTurnKeepsThePluginsMarkerTime(t *testing.T) {
	for _, tc := range []struct{ name, output, state, since string }{
		{"busy", "busy 2026-11-20T12:31:27Z", "busy", "2026-11-20T12:31:27Z"},
		{"idle", "idle 2026-11-20T12:59:00Z", "idle", "2026-11-20T12:59:00Z"},
		{"not marked", "unknown", "unknown", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			if err := os.MkdirAll(filepath.Join(root, "scripts"), 0700); err != nil {
				t.Fatal(err)
			}
			script := "#!/bin/sh\n[ \"$1\" = turn ] || exit 2\nprintf '%s\\n' '" + tc.output + "'\n"
			if err := os.WriteFile(filepath.Join(root, "scripts", "aeolus-identity.sh"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			got := (Plugin{Root: root, Data: t.TempDir()}).ReadTurn(t.TempDir())
			if got.State != tc.state || got.Since != tc.since {
				t.Fatalf("ReadTurn(%q) = %+v, want %s since %s", tc.output, got, tc.state, tc.since)
			}
		})
	}
}
