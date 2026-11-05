// Package hold is a session's hold (headless H8 to H12): a small process per
// session, started outside the trierarch's service so it outlives it, the
// only holder of its harness's stdin and stdout. It starts the harness as its
// child in a process group of its own, appends every line the harness writes
// to the session's events, keeps the harness's session id, and answers the
// trierarch alone on its socket, one JSON line each way, in today's protocol:
// send a line, interrupt the turn, say its state. When the harness ends, the
// hold ends; when the hold is stopped, the harness's group ends with it. A
// hold that dies without the chance to stop it, as SIGKILL leaves it, still
// ends its harness: a guard, this program run as `hold --guard` in a session
// of its own, holds a pipe from the hold and ends each harness's group once
// that pipe closes, which the hold's death does.
//
// Claude Code's turn is stopped with the interrupt control request on its
// stdin, which keeps the process (H12). When Claude Code refuses it, SIGINT
// stops the turn and the process, and the hold starts it again resuming its
// session, so the trierarch sees no exit.
//
// Codex runs one `codex exec` per turn (H11): the start command is the first
// turn, and each line sent is the prompt of a `codex exec resume` of the
// thread the first named, started once the last turn's process has ended.
// Between turns no Codex process runs and the hold stays; its turn is stopped
// with SIGINT, which ends the process (H12).
//
// Copilot runs one `copilot -p` per turn in the same way (CC4), each line the
// prompt of one resuming the session the last turn's result named. The
// `copilot` on the PATH is a launcher that runs the native Copilot as its
// child: a turn ends when the native process closed its output, not when the
// launcher exits, and its turn is stopped with SIGINT to its whole process
// group, since a SIGINT to the launcher alone ends the launcher and leaves the
// native process running the turn to its end. What Copilot writes on stderr is
// kept among the events, as it says a refused model or login there before any
// event. A turn that ends with a failing exit status ends the hold with it: the
// turn died, and the trierarch starts the session again.
package hold

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/peer"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/proxytoken"
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

// Refused is the answer a hold gives a caller that is not the trierarch, as today's hold words it.
const Refused = "refused: only the trierarch talks to a hold"

// InterruptWait is the longest the hold waits for an interrupted turn to end (timings-and-limits.md).
const InterruptWait = 10 * time.Second

const (
	// resume resumes a Claude Code session by its id; continueFlag continues the folder's last, which a resume replaces.
	resume       = "--resume"
	continueFlag = "--continue"
	claudeCode   = "claude-code"
	codex        = "codex"
	copilot      = "copilot"
)

// StderrEvent is the type of the line the hold keeps for each line Copilot writes on stderr, so the launch window reads what Copilot says before any event.
const StderrEvent = "aeolus.stderr"

type Options struct {
	Files  Files
	Folder string
	// Harness is the harness the command runs: how its turn is stopped.
	Harness string
	// Command is the harness's command line.
	Command []string
	// Environment is the harness's whole environment: nothing else of the hold's reaches it (H10).
	Environment []string
	Version     string
	// Stop is closed when the hold is told to stop.
	Stop <-chan struct{}
	// Guard is the command line of the guard, none when empty.
	Guard []string
	// MayCall is whether the process at the other end of a connection may call the hold (H9); every caller may when nil.
	MayCall func(pid int) bool
}

// event is what the harness's output or its end tells the hold.
type event struct {
	kind      string
	requestID string
	isRefused bool
}

const (
	resultEvent  = "result"
	controlEvent = "control"
	exitEvent    = "exit"
)

// harness is one run of the harness's command.
type harness struct {
	command *exec.Cmd
	stdin   io.WriteCloser
}

// isTurnPerProcess is whether the harness runs one process per turn, with none between turns (H11, CC4).
func (h *held) isTurnPerProcess() bool {
	return h.options.Harness == codex || h.options.Harness == copilot
}

type held struct {
	options Options
	events  *os.File
	guard   io.Writer

	mutex        sync.Mutex
	child        *harness
	sessionID    string
	isBusy       bool
	isRestarting bool
	isStopping   bool
	controls     int
	// turns takes the lines of a harness with a process per turn one at a time, so two never start a turn on one session.
	turns    sync.Mutex
	watchers map[chan event]struct{}
	// ended takes the exit code that ends the hold, once.
	ended chan int
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
	h := &held{options: options, events: events, watchers: map[chan event]struct{}{}, ended: make(chan int, 1)}
	if len(options.Guard) > 0 {
		guard, err := startGuard(options.Guard)
		if err != nil {
			return 1
		}
		defer guard.Close()
		h.guard = guard
	}

	h.mutex.Lock()
	first, err := h.start(options.Command)
	h.mutex.Unlock()
	if err != nil {
		return 1
	}

	listener, err := net.Listen("unix", files.Socket)
	if err != nil {
		killGroup(first, syscall.SIGKILL)
		return 1
	}
	go h.serve(listener)

	var code int
	select {
	case code = <-h.ended:
	case <-options.Stop:
		code = h.stop()
	}
	h.mutex.Lock()
	last := h.child
	h.mutex.Unlock()
	// What the harness started is ended with it, whichever way it ended.
	if last != nil {
		killGroup(last, syscall.SIGKILL)
	}
	_ = listener.Close()
	_ = os.Remove(files.Socket)
	return code
}

// startGuard starts the guard in a session of its own, so a signal to the hold's group does not end it before it ends the harness, with nothing of the hold's environment; answers the pipe it reads.
func startGuard(line []string) (io.WriteCloser, error) {
	guard := exec.Command(line[0], line[1:]...)
	guard.Env = []string{}
	guard.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	stdin, err := guard.StdinPipe()
	if err != nil {
		return nil, err
	}
	if err := guard.Start(); err != nil {
		return nil, err
	}
	go func() { _ = guard.Wait() }()
	return stdin, nil
}

// start starts a run of the command, with the hold's mutex held, and makes it the hold's child. A harness with a process per turn gets no stdin: codex exec reads one that is no terminal to its end before its turn, and copilot -p may take it as its prompt.
func (h *held) start(command []string) (*harness, error) {
	run := exec.Command(command[0], command[1:]...)
	run.Dir = h.options.Folder
	run.Env = h.options.Environment
	// A process group of its own: a stop ends the harness and every process it started.
	run.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var stdin io.WriteCloser
	if !h.isTurnPerProcess() {
		pipe, err := run.StdinPipe()
		if err != nil {
			return nil, err
		}
		stdin = pipe
	}
	// Pipes of its own, so the harness's end is seen even while a process it started still holds its output.
	stdout, output, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	run.Stdout = output
	readers := []*os.File{stdout}
	writers := []*os.File{output}
	if h.options.Harness == copilot {
		stderr, errorOutput, err := os.Pipe()
		if err != nil {
			_ = stdout.Close()
			_ = output.Close()
			return nil, err
		}
		run.Stderr = errorOutput
		readers = append(readers, stderr)
		writers = append(writers, errorOutput)
	}
	if err := run.Start(); err != nil {
		for _, file := range append(readers, writers...) {
			_ = file.Close()
		}
		return nil, err
	}
	for _, writer := range writers {
		_ = writer.Close()
	}
	started := &harness{command: run, stdin: stdin}
	h.child = started
	if h.isTurnPerProcess() {
		h.isBusy = true
	}
	if h.guard != nil {
		_, _ = fmt.Fprintf(h.guard, "%d\n", run.Process.Pid)
	}
	read := make(chan struct{})
	var reading sync.WaitGroup
	reading.Add(len(readers))
	go h.read(stdout, h.onLine, &reading)
	if len(readers) > 1 {
		go h.read(readers[1], func(line string) { h.onLine(stderrLine(line)) }, &reading)
	}
	go func() {
		reading.Wait()
		close(read)
	}()
	go h.wait(started, readers, read)
	return started, nil
}

// stderrLine is the line the hold keeps for a line Copilot wrote on stderr.
func stderrLine(line string) string {
	var text strings.Builder
	encoder := json.NewEncoder(&text)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(struct {
		Type string `json:"type"`
		Line string `json:"line"`
	}{Type: StderrEvent, Line: line})
	return strings.TrimSuffix(text.String(), "\n")
}

// read appends each line the harness writes to the events, and tells what it says.
func (h *held) read(output io.Reader, onLine func(line string), reading *sync.WaitGroup) {
	defer reading.Done()
	lines := bufio.NewScanner(output)
	lines.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for lines.Scan() {
		onLine(lines.Text())
	}
}

// onLine keeps the line in the events, then acts on it, so whoever a result or a control response answers finds it there.
func (h *held) onLine(line string) {
	_, _ = h.events.WriteString(line + "\n")
	var said struct {
		Type      string `json:"type"`
		SessionID string `json:"session_id"`
		// ThreadID is the thread a Codex turn names, which a later turn resumes.
		ThreadID string `json:"thread_id"`
		// CopilotSessionID is the session a Copilot result names, the only event naming it.
		CopilotSessionID string `json:"sessionId"`
		Response         *struct {
			Subtype   string `json:"subtype"`
			RequestID string `json:"request_id"`
		} `json:"response"`
	}
	if json.Unmarshal([]byte(line), &said) != nil {
		return
	}
	h.mutex.Lock()
	defer h.mutex.Unlock()
	id := said.SessionID
	switch h.options.Harness {
	case codex:
		id = ""
		if said.Type == "thread.started" {
			id = said.ThreadID
		}
	case copilot:
		id = ""
		if said.Type == "result" {
			id = said.CopilotSessionID
		}
	}
	if id != "" && id != h.sessionID {
		h.sessionID = id
		_ = os.WriteFile(h.options.Files.SessionID, []byte(id), 0o600)
	}
	if said.Type == "result" {
		h.isBusy = false
		h.tell(event{kind: resultEvent})
	}
	if said.Type == "control_response" && said.Response != nil {
		h.tell(event{kind: controlEvent, requestID: said.Response.RequestID, isRefused: said.Response.Subtype == "error"})
	}
}

// wait waits for the run to end, its last lines kept, and ends the hold with it unless the hold starts its harness again or runs a process per turn. Copilot's turn ends once its native process closed the output it inherited from the launcher, which may exit first; a Copilot turn that failed died, and ends the hold with its status, one the hold stopped by a signal not.
func (h *held) wait(run *harness, outputs []*os.File, read <-chan struct{}) {
	err := run.command.Wait()
	if h.options.Harness == copilot {
		<-read
	} else {
		select {
		case <-read:
		case <-time.After(time.Second):
		}
	}
	for _, output := range outputs {
		_ = output.Close()
	}
	code := 1
	isExited := false
	var exit *exec.ExitError
	switch {
	case err == nil:
		code, isExited = 0, true
	case errors.As(err, &exit) && exit.ExitCode() >= 0:
		code, isExited = exit.ExitCode(), true
	}
	h.mutex.Lock()
	defer h.mutex.Unlock()
	isTurnPerProcess := h.isTurnPerProcess()
	if isTurnPerProcess && h.child == run {
		h.isBusy = false
		h.child = nil
	}
	h.tell(event{kind: exitEvent})
	isDiedTurn := h.options.Harness == copilot && isExited && code != 0
	if h.isStopping || isDiedTurn || (!h.isRestarting && !isTurnPerProcess) {
		select {
		case h.ended <- code:
		default:
		}
	}
}

// tell tells every watcher the event, with the mutex held; a watcher that has not taken the last one misses none, as each has room.
func (h *held) tell(said event) {
	for watcher := range h.watchers {
		select {
		case watcher <- said:
		default:
		}
	}
}

func (h *held) watch() chan event {
	watcher := make(chan event, 16)
	h.mutex.Lock()
	h.watchers[watcher] = struct{}{}
	h.mutex.Unlock()
	return watcher
}

func (h *held) unwatch(watcher chan event) {
	h.mutex.Lock()
	delete(h.watchers, watcher)
	h.mutex.Unlock()
}

// waitFor waits until the watcher is told what it waits for, or the time is up.
func waitFor(watcher <-chan event, isIt func(event) bool, until time.Time) (event, bool) {
	timer := time.NewTimer(time.Until(until))
	defer timer.Stop()
	for {
		select {
		case said := <-watcher:
			if isIt(said) {
				return said, true
			}
		case <-timer.C:
			return event{}, false
		}
	}
}

func (h *held) serve(listener net.Listener) {
	for {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		go h.answerOn(connection)
	}
}

func (h *held) answerOn(connection net.Conn) {
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(30 * time.Second))
	// The call is read first, a refused one too: a connection closed with its call unread may answer the caller's write with a broken pipe instead of the refusal.
	line, err := bufio.NewReader(connection).ReadBytes('\n')
	if h.options.MayCall != nil && !h.options.MayCall(peer.PID(connection)) {
		writeAnswer(connection, Answer{Error: Refused})
		return
	}
	if err != nil && len(line) == 0 {
		return
	}
	var request Request
	answered := Answer{Error: "not a hold call"}
	if json.Unmarshal(line, &request) == nil {
		answered = h.answer(request)
	}
	writeAnswer(connection, answered)
}

func writeAnswer(connection net.Conn, answer Answer) {
	text, _ := json.Marshal(answer)
	_, _ = connection.Write(append(text, '\n'))
}

func (h *held) answer(request Request) Answer {
	switch request.Call {
	case "send":
		if h.isTurnPerProcess() {
			return h.sendTurn(request.Line)
		}
		h.mutex.Lock()
		defer h.mutex.Unlock()
		if h.child == nil {
			return Answer{Error: "the harness is not running"}
		}
		h.isBusy = true
		if _, err := h.child.stdin.Write([]byte(request.Line + "\n")); err != nil {
			return Answer{Error: "the harness takes no more lines: " + err.Error()}
		}
		return Answer{IsOK: true}
	case "interrupt":
		h.interrupt()
		return Answer{IsOK: true}
	case "state":
		h.mutex.Lock()
		defer h.mutex.Unlock()
		return Answer{IsOK: true, State: &State{Status: "running", Version: h.options.Version, SessionID: h.sessionID}}
	}
	return Answer{Error: "not a hold call"}
}

// interrupt stops a busy turn: Claude Code's with the interrupt control request, which keeps the process; refused, SIGINT ends the turn and the process, which starts again resuming its session (H12).
func (h *held) interrupt() {
	until := time.Now().Add(InterruptWait)
	watcher := h.watch()
	defer h.unwatch(watcher)
	h.mutex.Lock()
	current := h.child
	if !h.isBusy || current == nil {
		h.mutex.Unlock()
		return
	}
	if h.isTurnPerProcess() {
		h.mutex.Unlock()
		h.endTurn(watcher, syscall.SIGINT)
		return
	}
	isClaudeCode := h.options.Harness == claudeCode
	if isClaudeCode {
		h.controls++
		requestID := "aeolus-interrupt-" + strconv.Itoa(h.controls)
		request, _ := json.Marshal(map[string]any{"type": "control_request", "request_id": requestID, "request": map[string]string{"subtype": "interrupt"}})
		_, _ = current.stdin.Write(append(request, '\n'))
		h.mutex.Unlock()
		said, ok := waitFor(watcher, func(said event) bool {
			return said.kind != controlEvent || said.requestID == requestID
		}, until)
		if !ok || said.kind != controlEvent {
			return
		}
		if !said.isRefused {
			_, _ = waitFor(watcher, func(said event) bool { return said.kind == resultEvent || said.kind == exitEvent }, until)
			return
		}
		h.mutex.Lock()
	}
	// SIGINT ends the turn, and Claude Code's process with it: started again resuming its session, no exit for the trierarch to see.
	h.isRestarting = isClaudeCode
	h.mutex.Unlock()
	_ = current.command.Process.Signal(syscall.SIGINT)
	_, _ = waitFor(watcher, func(said event) bool { return said.kind == exitEvent }, until)
	h.mutex.Lock()
	defer h.mutex.Unlock()
	if !h.isRestarting {
		return
	}
	h.isRestarting = false
	if h.isStopping {
		return
	}
	h.isBusy = false
	if _, err := h.start(h.resumed()); err != nil {
		select {
		case h.ended <- 1:
		default:
		}
	}
}

// sendTurn starts the line's turn once the last turn's process has ended: a codex exec resume of the session's thread (H11), or a copilot -p resuming its session (CC4). A last turn that has not ended within the wait is ended.
func (h *held) sendTurn(line string) Answer {
	h.turns.Lock()
	defer h.turns.Unlock()
	watcher := h.watch()
	defer h.unwatch(watcher)
	h.mutex.Lock()
	running := h.child
	h.mutex.Unlock()
	if running != nil {
		_, _ = waitFor(watcher, func(said event) bool { return said.kind == exitEvent }, time.Now().Add(InterruptWait))
		h.mutex.Lock()
		isStill := h.child == running
		h.mutex.Unlock()
		if isStill {
			h.endTurn(watcher, syscall.SIGKILL)
		}
	}
	h.mutex.Lock()
	defer h.mutex.Unlock()
	if h.isStopping {
		return Answer{Error: "the hold is stopping"}
	}
	if h.sessionID == "" {
		if h.options.Harness == copilot {
			return Answer{Error: "Copilot named no session to resume yet"}
		}
		return Answer{Error: "Codex named no thread to resume yet"}
	}
	command := codexTurn(h.options.Command, h.sessionID, line)
	if h.options.Harness == copilot {
		command = copilotTurn(h.options.Command, h.sessionID, line)
	}
	if _, err := h.start(command); err != nil {
		return Answer{Error: "the turn did not start: " + err.Error()}
	}
	return Answer{IsOK: true}
}

// endTurn ends the running turn of a harness with a process per turn: SIGINT, to Copilot's whole group, since the launcher alone would end and leave the turn running, or SIGKILL to its group; its group killed when it has not ended within the wait (H12).
func (h *held) endTurn(watcher <-chan event, signal syscall.Signal) {
	h.mutex.Lock()
	running := h.child
	h.mutex.Unlock()
	if running == nil {
		return
	}
	switch {
	case signal == syscall.SIGINT && h.options.Harness == copilot:
		killGroup(running, syscall.SIGINT)
	case signal == syscall.SIGINT:
		_ = running.command.Process.Signal(syscall.SIGINT)
	default:
		killGroup(running, signal)
	}
	isEnded := func() bool {
		h.mutex.Lock()
		defer h.mutex.Unlock()
		return h.child != running
	}
	for range 2 {
		if isEnded() {
			return
		}
		if _, ok := waitFor(watcher, func(said event) bool { return said.kind == exitEvent }, time.Now().Add(InterruptWait)); ok && isEnded() {
			return
		}
		killGroup(running, syscall.SIGKILL)
	}
}

// codexTurn is the command of a later Codex turn (H11): the session's start command, resuming its thread by id instead of the folder's last conversation, with the line as its prompt after `--`. The program is every word before exec.
func codexTurn(start []string, threadID string, line string) []string {
	words := start
	if end := slices.Index(start, "--"); end >= 0 {
		words = start[:end]
	}
	at := slices.Index(words, "exec")
	if at < 0 {
		at = len(words)
	}
	flags := []string{}
	if at < len(words) {
		flags = words[at+1:]
	}
	if len(flags) >= 2 && flags[0] == "resume" && flags[1] == "--last" {
		flags = flags[2:]
	}
	turn := append(slices.Clone(words[:at]), "exec", "resume", threadID)
	turn = append(turn, flags...)
	return append(turn, "--", line)
}

// copilotTurn is the command of a later Copilot turn (CC4): the session's start command, resuming the session by the id given, with the line as its prompt.
func copilotTurn(start []string, sessionID string, line string) []string {
	turn := slices.DeleteFunc(slices.Clone(start), func(word string) bool {
		return strings.HasPrefix(word, "--resume=") || strings.HasPrefix(word, "--prompt=")
	})
	return append(turn, "--resume="+sessionID, "--prompt="+line)
}

// resumed is the command that starts Claude Code again resuming its session, or continuing the folder's last when it named none.
func (h *held) resumed() []string {
	command := slices.DeleteFunc(slices.Clone(h.options.Command), func(word string) bool { return word == continueFlag })
	if h.sessionID == "" {
		return append(command, continueFlag)
	}
	return append(command, resume, h.sessionID)
}

// stop ends the harness's group: SIGTERM, then SIGKILL after the grace; answers its exit code.
func (h *held) stop() int {
	h.mutex.Lock()
	h.isStopping = true
	current := h.child
	h.mutex.Unlock()
	if current == nil {
		return 0
	}
	killGroup(current, syscall.SIGTERM)
	select {
	case code := <-h.ended:
		return code
	case <-time.After(stopGrace):
		killGroup(current, syscall.SIGKILL)
		return <-h.ended
	}
}

func killGroup(run *harness, signal syscall.Signal) {
	_ = syscall.Kill(-run.command.Process.Pid, signal)
}

// stopGrace is how long a stopped harness has to end after SIGTERM before SIGKILL.
const stopGrace = 5 * time.Second

// guardGrace is how long the guard gives a harness's group to end after SIGTERM before SIGKILL.
const guardGrace = 2 * time.Second

// Guard is the guard: each line it reads is the group of a harness the hold started; once its input closes, as the hold's end closes it, every such group is ended.
func Guard(input io.Reader) int {
	// The hold's group may be signalled as a whole: the guard outlives it.
	signal.Ignore(syscall.SIGHUP, syscall.SIGINT, syscall.SIGTERM)
	groups := []int{}
	lines := bufio.NewScanner(input)
	for lines.Scan() {
		if group, err := strconv.Atoi(strings.TrimSpace(lines.Text())); err == nil && group > 1 {
			groups = append(groups, group)
		}
	}
	for _, group := range groups {
		_ = syscall.Kill(-group, syscall.SIGTERM)
	}
	time.Sleep(guardGrace)
	for _, group := range groups {
		_ = syscall.Kill(-group, syscall.SIGKILL)
	}
	return 0
}

// TrierarchOnly is whether a caller may call a hold (H9): only the trierarch, never a session. A caller is refused when it runs under any hold in the sessions folder, whichever ship's, when it is in the process session of one, as a process a session forked stays once it is reparented (#196), and when it does not resolve. The trierarch starts each hold outside its own process tree and in a process session of its own, so the trierarch is under none of them and in none of their sessions. A process that leaves its session on purpose (setsid) and is reparented is answered: no refusal list tells it from the trierarch, and a container is the isolation against it (#174).
func TrierarchOnly(sessions string) func(pid int) bool {
	return func(pid int) bool {
		roots := Roots(sessions)
		return pid > 0 && !peer.IsUnder(pid, roots) && !peer.IsInSessionOf(pid, roots)
	}
}

// Roots are the pids of the holds in the sessions folder, as their pid files say them.
func Roots(sessions string) []int {
	folders, err := os.ReadDir(sessions)
	if err != nil {
		return nil
	}
	roots := []int{}
	for _, folder := range folders {
		text, err := os.ReadFile(filepath.Join(sessions, folder.Name(), "hold.pid"))
		if err != nil {
			continue
		}
		if pid, err := strconv.Atoi(strings.TrimSpace(string(text))); err == nil && pid > 1 {
			roots = append(roots, pid)
		}
	}
	return roots
}

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

// keptVariables are what the harness takes of the hold's own environment; everything else it is given. USER and LOGNAME name the user, by which Claude Code finds its login on macOS.
var keptVariables = []string{"HOME", "PATH", "USER", "LOGNAME"}

const usage = "Usage: aeolus-trierarch hold <ship id> --sessions <folder> --folder <folder> --harness <name> [--proxy-token-variable NAME] [--env NAME=value]... -- <command>..."

// Main runs `aeolus-trierarch hold` with the words after `hold`, as the trierarch starts it, never a person: the harness's environment is built from nothing (H10), the kept variables of the hold's own, then each --env given, and with --proxy-token-variable the session's model proxy token from its folder in that variable (H16); its guard is this program run as `hold --guard`. Answers its exit code, or 2 for words it cannot take.
func Main(words []string, version string, environ []string) int {
	if len(words) == 1 && words[0] == "--guard" {
		return Guard(os.Stdin)
	}
	end := slices.Index(words, "--")
	if end < 1 || end == len(words)-1 {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	shipID, options, command := words[0], words[1:end], words[end+1:]
	values := map[string]string{}
	given := []string{}
	for at := 0; at+1 < len(options); at += 2 {
		if options[at] == "--env" {
			given = append(given, options[at+1])
		} else {
			values[options[at]] = options[at+1]
		}
	}
	if values["--sessions"] == "" || values["--folder"] == "" || values["--harness"] == "" || strings.Contains(shipID, "/") {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	program, err := os.Executable()
	if err != nil {
		return 1
	}
	environment := []string{}
	for _, entry := range environ {
		if name, _, _ := strings.Cut(entry, "="); slices.Contains(keptVariables, name) {
			environment = append(environment, entry)
		}
	}
	stop := make(chan struct{})
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGINT)
	go func() {
		<-signals
		close(stop)
	}()
	sessions := values["--sessions"]
	files := FilesOf(sessions, shipID)
	if variable := values["--proxy-token-variable"]; variable != "" {
		token, ok := proxytoken.Read(files.Folder)
		if !ok {
			fmt.Fprintf(os.Stderr, "No proxy token in %s\n", files.Folder)
			return 1
		}
		given = append(given, variable+"="+token.Token)
	}
	return Run(Options{
		Files:       files,
		Folder:      values["--folder"],
		Harness:     values["--harness"],
		Command:     command,
		Environment: append(environment, given...),
		Version:     version,
		Stop:        stop,
		Guard:       []string{program, "hold", "--guard"},
		MayCall:     TrierarchOnly(sessions),
	})
}
