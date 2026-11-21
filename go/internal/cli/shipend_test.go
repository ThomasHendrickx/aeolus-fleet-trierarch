package cli

import (
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/ended"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/shipview"
)

func TestShipStatusNamesLastEndOrWhyItCannotBeRead(t *testing.T) {
	for _, example := range []struct {
		name       string
		end        *ended.End
		unreadable []shipview.Unreadable
		want       string
	}{
		{name: "kept", end: &ended.End{EndedAt: "2026-11-20T13:30:09Z", ExitReason: "exit status 1"}, want: "Last end: 2026-11-20T13:30:09Z, exit status 1"},
		{name: "none", want: "Last end: none kept: no session of this ship ended since it was crewed here"},
		{name: "unreadable", unreadable: []shipview.Unreadable{{Fact: "last end", Path: "/example/ended/one.json", Error: "unexpected end of JSON input"}}, want: "Last end: unreadable: /example/ended/one.json: unexpected end of JSON input"},
	} {
		t.Run(example.name, func(t *testing.T) {
			got := describeShip(shipview.View{LastEnd: example.end, Unreadable: example.unreadable}, time.Now())
			if !strings.Contains(got, example.want) {
				t.Fatalf("status = %s, want %s", got, example.want)
			}
		})
	}
}
