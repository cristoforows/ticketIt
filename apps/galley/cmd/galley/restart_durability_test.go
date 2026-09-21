package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/cristoforows/ticketIt/apps/galley/internal/postgres"
)

// TestRestartDurability_DiagnosticNoteSurvivesFreshProcess is issue
// #52's required restart-durability test. It deliberately does not
// call run() twice in this same test binary -- that would only prove
// a fresh in-process pgxpool.Pool and http.Server survive, which the
// issue explicitly calls out as insufficient ("not just a new database
// connection or a transaction commit"). Instead it builds the real
// galley binary and runs it as two separate, unrelated OS processes
// against the same real PostgreSQL database: writes a diagnostic note
// through the first process, terminates it completely (waits for exit,
// not just for the socket to close), starts a second, brand-new
// process with no shared memory of any kind with the first, and reads
// the note back through it.
func TestRestartDurability_DiagnosticNoteSurvivesFreshProcess(t *testing.T) {
	postgres.NewTestPool(t) // ensures the real test database exists and is migrated
	databaseURL := postgres.TestingURL()

	binPath := buildGalleyBinary(t)
	note := uniqueNote(t)

	// First process: write the note.
	proc1 := startGalley(t, binPath, databaseURL)
	created := postDiagnosticNote(t, proc1.baseURL, note)
	stopGalleyCleanly(t, proc1)

	// Second process: a completely fresh binary invocation -- new PID,
	// new address space, new pgxpool.Pool, new http.Server. Only the
	// database is shared.
	proc2 := startGalley(t, binPath, databaseURL)
	defer stopGalleyCleanly(t, proc2)

	notes := getDiagnosticNotes(t, proc2.baseURL)

	found := false
	for _, n := range notes {
		if n.Id == created.Id && n.Note == note {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("note written by the first process (id=%d, note=%q) was not readable from a genuinely fresh second process; got %d notes", created.Id, note, len(notes))
	}
}

func uniqueNote(t *testing.T) string {
	t.Helper()
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("failed to generate a unique note: %v", err)
	}
	return "restart_durability_test-" + hex.EncodeToString(b[:])
}

// buildGalleyBinary compiles cmd/galley once into t.TempDir(), so both
// process launches in this test run the exact same, freshly built
// binary as two independent executions.
func buildGalleyBinary(t *testing.T) string {
	t.Helper()

	moduleRoot, err := os.Getwd()
	if err != nil {
		t.Fatalf("failed to determine working directory: %v", err)
	}
	// This test file lives in apps/galley/cmd/galley; the module root
	// (where "go build ./cmd/galley" must run from) is two levels up.
	moduleRoot = moduleRoot + "/../.."

	binPath := t.TempDir() + "/galley-restart-durability-test"
	cmd := exec.Command("go", "build", "-o", binPath, "./cmd/galley")
	cmd.Dir = moduleRoot
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("failed to build galley binary: %v\n%s", err, out)
	}
	return binPath
}

type galleyProcess struct {
	cmd     *exec.Cmd
	baseURL string
	stdout  *bytes.Buffer
}

// startGalley launches binPath as a brand-new OS process listening on
// an OS-assigned port (GALLEY_PORT=0), and waits for it to report
// itself ready by scanning its structured stdout log for the
// "galley listening" line cmd/galley/main.go already emits -- the same
// mechanism cmd/galley's own in-process tests use via the ready
// channel, but observed from outside the process here since there is
// no Go channel across an exec boundary.
func startGalley(t *testing.T, binPath, databaseURL string) *galleyProcess {
	t.Helper()

	cmd := exec.Command(binPath)
	cmd.Env = []string{
		"GALLEY_HOST=127.0.0.1",
		"GALLEY_PORT=0",
		"GALLEY_ENVIRONMENT=development",
		"GALLEY_VERSION=restart-durability-test",
		"DATABASE_URL=" + databaseURL,
	}
	if home, ok := os.LookupEnv("HOME"); ok {
		cmd.Env = append(cmd.Env, "HOME="+home)
	}

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("failed to attach to galley's stdout: %v", err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start galley process: %v", err)
	}

	addrCh := make(chan string, 1)
	captured := &bytes.Buffer{}
	go func() {
		scanner := bufio.NewScanner(stdoutPipe)
		for scanner.Scan() {
			line := scanner.Text()
			captured.WriteString(line)
			captured.WriteByte('\n')

			var entry struct {
				Msg  string `json:"msg"`
				Addr string `json:"addr"`
			}
			if err := json.Unmarshal([]byte(line), &entry); err == nil && entry.Msg == "galley listening" && entry.Addr != "" {
				select {
				case addrCh <- entry.Addr:
				default:
				}
			}
		}
	}()

	var addr string
	select {
	case addr = <-addrCh:
	case <-time.After(10 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatalf("timed out waiting for galley process to report it is listening; stderr=%s stdout=%s", stderr.String(), captured.String())
	}

	return &galleyProcess{
		cmd:     cmd,
		baseURL: "http://" + addr,
		stdout:  captured,
	}
}

// stopGalleyCleanly sends a real SIGTERM (the same signal
// cmd/galley/main.go's own graceful-shutdown path handles) and waits
// for the process to exit, so the next process launched in this test
// never races a still-shutting-down predecessor.
func stopGalleyCleanly(t *testing.T, p *galleyProcess) {
	t.Helper()
	if p.cmd.ProcessState != nil {
		return // already exited (e.g. stopped explicitly earlier in the test)
	}

	if err := p.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("failed to send SIGTERM to galley process: %v", err)
	}

	done := make(chan error, 1)
	go func() { done <- p.cmd.Wait() }()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("galley process exited with error after SIGTERM: %v (stdout=%s)", err, p.stdout.String())
		}
	case <-time.After(10 * time.Second):
		_ = p.cmd.Process.Kill()
		t.Fatalf("galley process did not exit within 10s of SIGTERM")
	}
}

type diagnosticNote struct {
	Id        int    `json:"id"`
	Note      string `json:"note"`
	CreatedAt string `json:"createdAt"`
}

func postDiagnosticNote(t *testing.T, baseURL, note string) diagnosticNote {
	t.Helper()

	body := fmt.Sprintf(`{"note":%q}`, note)
	resp, err := http.Post(baseURL+"/api/dev/diagnostic-notes", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST /api/dev/diagnostic-notes failed: %v", err)
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /api/dev/diagnostic-notes status = %d, want %d; body=%s", resp.StatusCode, http.StatusCreated, data)
	}

	var created diagnosticNote
	if err := json.Unmarshal(data, &created); err != nil {
		t.Fatalf("failed to decode create response %q: %v", data, err)
	}
	return created
}

func getDiagnosticNotes(t *testing.T, baseURL string) []diagnosticNote {
	t.Helper()

	resp, err := http.Get(baseURL + "/api/dev/diagnostic-notes")
	if err != nil {
		t.Fatalf("GET /api/dev/diagnostic-notes failed: %v", err)
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/dev/diagnostic-notes status = %d, want %d; body=%s", resp.StatusCode, http.StatusOK, data)
	}

	var list struct {
		Notes []diagnosticNote `json:"notes"`
	}
	if err := json.Unmarshal(data, &list); err != nil {
		t.Fatalf("failed to decode list response %q: %v", data, err)
	}
	return list.Notes
}
