package cli

import (
	"encoding/json"
	"errors"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/service"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/state"
)

func TestShipStandingReportsEachConditionAndTheExactMinuteBoundary(t *testing.T) {
	for _, tc := range []struct {
		name         string
		down, failed bool
		elapsed      time.Duration
		says         []string
	}{
		{"current", false, false, 4 * time.Second, []string{}},
		{"one minute", false, false, time.Minute, []string{}},
		{"over one minute", false, false, time.Minute + time.Second, []string{"The last pass was 1m ago: what is shown is stale."}},
		{"service down", true, false, 4 * time.Second, []string{"The trierarch's service is not running (aeolus-trierarch start): nothing below is current."}},
		{"failed", false, true, 4 * time.Second, []string{"The last pass failed, failing since 13:41:10: fleet unreachable: nothing below is current."}},
		{"combined", true, true, 2 * time.Minute, []string{"The trierarch's service is not running (aeolus-trierarch start): nothing below is current.", "The last pass failed, failing since 13:41:10: fleet unreachable: nothing below is current.", "The last pass was 2m ago: what is shown is stale."}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			machine, at := aShipStatus(t)
			service := &anInstalledService{aServiceManager: aServiceManager{running: true}}
			if tc.down {
				service.running = false
			}
			machine.Service = func(paths.Paths) ServiceManager { return service }
			stamp := machine.Now().Add(-tc.elapsed).Format(time.RFC3339)
			writeStatusFile(t, filepath.Join(at.Home, "seen.json"), `{"passAt":`+quoted(stamp)+`,"ships":{}}`)
			if tc.failed {
				data, err := state.File{Path: at.State}.Load()
				if err != nil {
					t.Fatal(err)
				}
				data.PassFailure = &reconciler.PassFailure{Since: "2026-11-20T12:41:10Z", Reason: "fleet unreachable"}
				if err := (state.File{Path: at.State}).Save(data); err != nil {
					t.Fatal(err)
				}
			}
			out, code := Main([]string{"status", "shp_one", "--json"}, machine)
			var got struct {
				Trierarch struct {
					Service     string
					LastPassAt  string
					PassFailure *reconciler.PassFailure
					IsCurrent   bool
					Says        []string
				}
			}
			if err := json.Unmarshal([]byte(out), &got); err != nil {
				t.Fatal(err)
			}
			want, _ := json.Marshal(tc.says)
			actual, _ := json.Marshal(got.Trierarch.Says)
			if code != 0 || string(actual) != string(want) || got.Trierarch.IsCurrent != (len(tc.says) == 0) || got.Trierarch.LastPassAt != stamp {
				t.Fatalf("status = %d %s, want says %s at %s", code, out, want, stamp)
			}
			out, code = Main([]string{"status", "shp_one"}, machine)
			if code != 0 || !strings.Contains(out, "Trierarch: ") {
				t.Fatalf("status = %d %s", code, out)
			}
			for _, s := range tc.says {
				if !strings.Contains(out, s) {
					t.Fatalf("status missing %q: %s", s, out)
				}
			}
			if len(tc.says) == 0 && !strings.Contains(out, "Trierarch: current, last pass ") {
				t.Fatal(out)
			}
		})
	}
}

func TestPlainStatusReportsTheLastSuccessfulPassAge(t *testing.T) {
	for _, tc := range []struct {
		name, stamp, want string
		failed            bool
	}{
		{"success", "2026-10-06T07:00:16Z", "Last pass: succeeded, 4s ago", false},
		{"failed with success", "2026-10-06T06:57:20Z", "Last pass: failed (last success 3m ago)", true},
		{"failed without success", "", "Last pass: failed (no success yet)", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			machine, _, _ := aMain(t)
			Main(setupWords(), machine)
			machine.Now = func() time.Time { return time.Date(2026, 10, 6, 7, 0, 20, 0, time.UTC) }
			at := paths.Of(machine.HomeDirectory, "")
			if tc.stamp != "" {
				writeStatusFile(t, filepath.Join(at.Home, "seen.json"), `{"passAt":`+quoted(tc.stamp)+`,"ships":{}}`)
			}
			if tc.failed {
				data, _ := state.File{Path: at.State}.Load()
				data.PassFailure = &reconciler.PassFailure{Since: "2026-10-06T07:00:19Z", Reason: "fleet unreachable"}
				if err := (state.File{Path: at.State}).Save(data); err != nil {
					t.Fatal(err)
				}
			}
			out, code := Main([]string{"status"}, machine)
			if code != 0 || !strings.Contains(out, tc.want+"\n") {
				t.Fatalf("status = %d %s, want %s", code, out, tc.want)
			}
		})
	}
}

func TestShipStandingKeepsOtherFactsWhenAPassOrServiceCannotBeRead(t *testing.T) {
	for _, kind := range []string{"missing", "malformed", "invalid time", "unreadable", "service"} {
		t.Run(kind, func(t *testing.T) {
			machine, at := aShipStatus(t)
			path := filepath.Join(at.Home, "seen.json")
			want := "no pass yet"
			switch kind {
			case "missing":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			case "malformed":
				writeStatusFile(t, path, `{"passAt":`)
				want = "unreadable: " + path
			case "invalid time":
				writeStatusFile(t, path, `{"passAt":"not-a-time","ships":{}}`)
				want = "unreadable: " + path
			case "unreadable":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
				want = "unreadable: " + path
			case "service":
				machine.Service = func(paths.Paths) ServiceManager { return &anUnreadableStandingService{} }
				want = "unreadable: /unit: service unavailable"
			}
			out, code := Main([]string{"status", "shp_one"}, machine)
			if code != 0 || !strings.Contains(out, "Ship: design-tri-271c") || !strings.Contains(out, "Trierarch: ") || !strings.Contains(out, want) {
				t.Fatalf("status = %d %s, want %s and ship facts", code, out, want)
			}
			out, code = Main([]string{"status", "shp_one", "--json"}, machine)
			var got struct {
				Trierarch struct {
					IsCurrent  bool
					LastPassAt *string
				}
			}
			if err := json.Unmarshal([]byte(out), &got); err != nil {
				t.Fatal(err)
			}
			if code != 0 || got.Trierarch.IsCurrent || (kind == "missing" && got.Trierarch.LastPassAt != nil) {
				t.Fatalf("JSON = %d %s", code, out)
			}
		})
	}
}

type anUnreadableStandingService struct{ anInstalledService }

func (*anUnreadableStandingService) Status() (service.Status, error) {
	return service.Status{File: "/unit"}, errors.New("service unavailable")
}
