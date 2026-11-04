package detection

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestACommandAnswersItsStatusAndWhatItWrote(t *testing.T) {
	ran := Run(context.Background(), Command{Program: "sh", Args: []string{"-c", "echo out; echo err >&2; exit 3"}, Timeout: 10 * time.Second})

	if ran != (Ran{Status: 3, Stdout: "out\n", Stderr: "err\n"}) {
		t.Errorf("Run() = %+v, want status 3, out and err", ran)
	}
}

func TestACommandRunsInTheFolderGiven(t *testing.T) {
	folder := t.TempDir()

	ran := Run(context.Background(), Command{Program: "pwd", Dir: folder, Timeout: 10 * time.Second})

	if ran.Stdout != folder+"\n" {
		t.Errorf("Run() stdout = %q, want %s", ran.Stdout, folder)
	}
}

func TestACommandThatRunsPastItsTimeIsEndedAndSaysNoStatus(t *testing.T) {
	started := time.Now()

	ran := Run(context.Background(), Command{Program: "sleep", Args: []string{"10"}, Timeout: 100 * time.Millisecond})

	if ran.Status != -1 || time.Since(started) > 5*time.Second {
		t.Errorf("Run() = %+v after %v, want status -1 at once", ran, time.Since(started))
	}
}

func TestAProgramThatIsMissingSaysNoStatus(t *testing.T) {
	if ran := Run(context.Background(), Command{Program: "aeolus-no-such-program", Timeout: time.Second}); ran.Status != -1 {
		t.Errorf("Run() = %+v, want status -1", ran)
	}
}

func TestANeutralFolderIsNewAndEmpty(t *testing.T) {
	folder, err := NeutralFolder()
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(folder)

	entries, err := os.ReadDir(folder)
	if err != nil || len(entries) != 0 {
		t.Errorf("ReadDir(%s) = %v, %v, want an empty folder", folder, entries, err)
	}
}
