package activity

import (
	"os"
	"testing"
)

func TestAnUnreadableEventsFileReturnsItsReadError(t *testing.T) {
	file, err := os.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	_, _, err = OfFile(file, func(string) (Reading, bool) { return Reading{Kind: "text"}, true })
	if err == nil {
		t.Fatal("an events directory returned no read error")
	}
}
