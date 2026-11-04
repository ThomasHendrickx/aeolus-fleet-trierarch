// Package hold is a session's hold (headless H8 to H12): a small process per
// session, started outside the trierarch's service so it outlives it, the
// only holder of its harness's stdin and stdout. It starts the harness as its
// child in a process group of its own, appends every line the harness writes
// to the session's events, keeps the harness's session id, and answers on its
// socket, one JSON line each way, in today's protocol: send a line, say its
// state. When the harness ends, the hold ends; when the hold is stopped, the
// harness's group ends with it.
//
// Not yet (binary 4/12): interrupt, the guard that ends the harness when the
// hold is killed, and telling the trierarch from another caller by the
// connection's peer; the socket is in a folder only the user reads.
package hold

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"
)

// Files are a session's hold files, in its folder under the sessions folder.
type Files struct {
	Folder string
	Socket string
	PID    string
	// Events holds every line the harness writes, appended.
	Events string
	// SessionID is the harness's own session id, as its events name it, so a start resumes it.
	SessionID string
}

func FilesOf(sessions string, shipID string) Files {
	folder := filepath.Join(sessions, shipID)
	return Files{Folder: folder, Socket: filepath.Join(folder, "hold.sock"), PID: filepath.Join(folder, "hold.pid"), Events: filepath.Join(folder, "events.jsonl"), SessionID: filepath.Join(folder, "session-id")}
}

// Request is one call to a hold.
type Request struct {
	Call string `json:"call"`
	Line string `json:"line,omitempty"`
}

// State is what a running hold says of itself.
type State struct {
	Status    string `json:"status"`
	Version   string `json:"version"`
	SessionID string `json:"sessionId,omitempty"`
}

// Answer is a hold's answer: ok, with its state when asked, or refused with why.
type Answer struct {
	IsOK  bool   `json:"isOk"`
	State *State `json:"state,omitempty"`
	Error string `json:"error,omitempty"`
}

type Options struct {
	Files  Files
	Folder string
	// Command is the harness's command line.
	Command []string
	// Environment is the harness's whole environment: nothing else of the hold's reaches it (H10).
	Environment []string
	Version     string
	// Stop is closed when the hold is told to stop.
	Stop <-chan struct{}
}

// Run runs the hold until its harness ends, and answers the harness's exit code.
func Run(options Options) int {
	files := options.Files
	if err := os.MkdirAll(files.Folder, 0o700); err != nil {
		return 1
	}
	_ = os.Remove(files.Socket)
	if err := os.WriteFile(files.PID, []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		return 1
	}
	events, err := os.OpenFile(files.Events, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return 1
	}
	defer events.Close()

	harness := exec.Command(options.Command[0], options.Command[1:]...)
	harness.Dir = options.Folder
	harness.Env = options.Environment
	// A process group of its own: a stop ends the harness and every process it started.
	harness.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := harness.StdinPipe()
	if err != nil {
		return 1
	}
	// A pipe of its own, so the harness's end is seen even while a process it started still holds its output.
	stdout, output, err := os.Pipe()
	if err != nil {
		return 1
	}
	harness.Stdout = output
	if err := harness.Start(); err != nil {
		return 1
	}
	_ = output.Close()

	var mutex sync.Mutex
	sessionID := ""
	read := make(chan struct{})
	go func() {
		defer close(read)
		lines := bufio.NewScanner(stdout)
		lines.Buffer(make([]byte, 64*1024), 64*1024*1024)
		for lines.Scan() {
			line := lines.Text()
			_, _ = events.WriteString(line + "\n")
			var event struct {
				SessionID string `json:"session_id"`
			}
			if json.Unmarshal([]byte(line), &event) == nil && event.SessionID != "" {
				mutex.Lock()
				if event.SessionID != sessionID {
					sessionID = event.SessionID
					_ = os.WriteFile(files.SessionID, []byte(sessionID), 0o600)
				}
				mutex.Unlock()
			}
		}
	}()

	answer := func(request Request) Answer {
		switch request.Call {
		case "send":
			mutex.Lock()
			defer mutex.Unlock()
			if _, err := stdin.Write([]byte(request.Line + "\n")); err != nil {
				return Answer{Error: "the harness takes no more lines: " + err.Error()}
			}
			return Answer{IsOK: true}
		case "state":
			mutex.Lock()
			defer mutex.Unlock()
			return Answer{IsOK: true, State: &State{Status: "running", Version: options.Version, SessionID: sessionID}}
		}
		return Answer{Error: "not a hold call"}
	}

	listener, err := net.Listen("unix", files.Socket)
	if err != nil {
		_ = syscall.Kill(-harness.Process.Pid, syscall.SIGKILL)
		_ = harness.Wait()
		return 1
	}
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer connection.Close()
				_ = connection.SetDeadline(time.Now().Add(30 * time.Second))
				line, err := bufio.NewReader(connection).ReadBytes('\n')
				if err != nil && len(line) == 0 {
					return
				}
				var request Request
				answered := Answer{Error: "not a hold call"}
				if json.Unmarshal(line, &request) == nil {
					answered = answer(request)
				}
				text, _ := json.Marshal(answered)
				_, _ = connection.Write(append(text, '\n'))
			}()
		}
	}()

	exited := make(chan int, 1)
	go func() {
		err := harness.Wait()
		var exit *exec.ExitError
		switch {
		case err == nil:
			exited <- 0
		case errors.As(err, &exit) && exit.ExitCode() >= 0:
			exited <- exit.ExitCode()
		default:
			exited <- 1
		}
	}()
	var code int
	select {
	case code = <-exited:
	case <-options.Stop:
		_ = syscall.Kill(-harness.Process.Pid, syscall.SIGTERM)
		select {
		case code = <-exited:
		case <-time.After(stopGrace):
			_ = syscall.Kill(-harness.Process.Pid, syscall.SIGKILL)
			code = <-exited
		}
	}
	// What the harness started is ended with it, whichever way it ended, and its last lines are kept.
	_ = syscall.Kill(-harness.Process.Pid, syscall.SIGKILL)
	select {
	case <-read:
	case <-time.After(time.Second):
	}
	_ = stdout.Close()
	_ = listener.Close()
	_ = os.Remove(files.Socket)
	return code
}

// stopGrace is how long a stopped harness has to end after SIGTERM before SIGKILL.
const stopGrace = 5 * time.Second

// Call calls the hold at the socket and answers what it said; a hold that does not answer within the time, or ends the call unanswered, is an error.
func Call(socket string, request Request, timeout time.Duration) (Answer, error) {
	connection, err := net.DialTimeout("unix", socket, timeout)
	if err != nil {
		return Answer{}, err
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(timeout))
	text, err := json.Marshal(request)
	if err != nil {
		return Answer{}, err
	}
	if _, err := connection.Write(append(text, '\n')); err != nil {
		return Answer{}, err
	}
	line, err := bufio.NewReader(connection).ReadBytes('\n')
	if err != nil && len(line) == 0 {
		return Answer{}, errors.New("the hold at " + socket + " gave no answer to " + request.Call)
	}
	var answer Answer
	if err := json.Unmarshal(line, &answer); err != nil {
		return Answer{}, errors.New("the hold at " + socket + " gave no answer to " + request.Call)
	}
	return answer, nil
}
