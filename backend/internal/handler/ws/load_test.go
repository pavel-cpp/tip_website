package ws

import (
	"context"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

const (
	loadRooms          = 10
	loadClientsPerRoom = 10
	loadRounds         = 20
	loadRoundPause     = 250 * time.Millisecond // 4 frames per round stays below 20 msg/s
	loadUpserts        = 40                     // published per room
)

type loadStats struct {
	upserts, locks, unlocks, denied, presence, other atomic.Int64
	unexpectedClose                                  atomic.Int64
}

func heapMiB() float64 {
	var m runtime.MemStats
	runtime.GC()
	runtime.GC()
	runtime.ReadMemStats(&m)
	return float64(m.HeapAlloc) / (1 << 20)
}

func waitGoroutines(limit int, d time.Duration) int {
	deadline := time.Now().Add(d)
	n := runtime.NumGoroutine()
	for n > limit && time.Now().Before(deadline) {
		time.Sleep(25 * time.Millisecond)
		n = runtime.NumGoroutine()
	}
	return n
}

// TestLoad100ClientsOver10Rooms drives 100 real WebSocket clients through
// locks, cursors, heartbeats and broadcasts, then checks that nothing leaks.
func TestLoad100ClientsOver10Rooms(t *testing.T) {
	if testing.Short() {
		t.Skip("load test skipped in -short mode")
	}
	baseGoroutines := runtime.NumGoroutine()
	baseHeap := heapMiB()

	e := newEnv(t, func(c *Config) { c.IdleTimeout = 30 * time.Second })
	var stats loadStats
	var readers sync.WaitGroup
	received := make([][]atomic.Int64, loadRooms) // upserts seen per client
	clients := make([][]*client, loadRooms)

	start := time.Now()
	connect := func(room, idx int) *client {
		cl, err := e.dial(fmt.Sprintf("room%d", room), nil)
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		cl.send(map[string]any{"t": "auth", "token": fmt.Sprintf("u%d-%d", room, idx)})
		if h := cl.recv(); h["t"] != "hello" {
			t.Fatalf("expected hello, got %v", h)
		}
		return cl
	}
	for room := 0; room < loadRooms; room++ {
		received[room] = make([]atomic.Int64, loadClientsPerRoom)
		clients[room] = make([]*client, loadClientsPerRoom)
		for idx := 0; idx < loadClientsPerRoom; idx++ {
			clients[room][idx] = connect(room, idx)
		}
	}
	connectTime := time.Since(start)

	for room := 0; room < loadRooms; room++ {
		for idx := 0; idx < loadClientsPerRoom; idx++ {
			readers.Add(1)
			go func() {
				defer readers.Done()
				cl := clients[room][idx]
				for {
					_, data, err := cl.c.Read(context.Background())
					if err != nil {
						if websocket.CloseStatus(err) != websocket.StatusNormalClosure && !strings.Contains(err.Error(), "closed") {
							stats.unexpectedClose.Add(1)
						}
						return
					}
					s := string(data)
					switch {
					case strings.HasPrefix(s, `{"t":"rows.upsert"`):
						stats.upserts.Add(1)
						received[room][idx].Add(1)
					case strings.HasPrefix(s, `{"t":"lock.denied"`):
						stats.denied.Add(1)
					case strings.HasPrefix(s, `{"t":"lock"`):
						stats.locks.Add(1)
					case strings.HasPrefix(s, `{"t":"unlock"`):
						stats.unlocks.Add(1)
					case strings.HasPrefix(s, `{"t":"presence"`):
						stats.presence.Add(1)
					default:
						stats.other.Add(1)
					}
				}
			}()
		}
	}

	runStart := time.Now()
	var workers sync.WaitGroup
	// Publishers: one per room.
	for room := 0; room < loadRooms; room++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for i := 0; i < loadUpserts; i++ {
				e.hub.Publish(fmt.Sprintf("room%d", room), domain.RowsUpserted(domain.Participant{
					ID: fmt.Sprintf("row%d", i), ProjectID: fmt.Sprintf("room%d", room), Version: i + 1, Name: "load",
				}))
				time.Sleep(loadRoundPause * loadRounds / loadUpserts)
			}
		}()
	}
	// Editors: every client contends for a small set of rows in its room.
	for room := 0; room < loadRooms; room++ {
		for idx := 0; idx < loadClientsPerRoom; idx++ {
			workers.Add(1)
			go func() {
				defer workers.Done()
				cl := clients[room][idx]
				for round := 0; round < loadRounds; round++ {
					row := fmt.Sprintf("r%d", (round+idx)%4)
					cl.send(map[string]any{"t": "lock.acquire", "rowId": row})
					cl.send(map[string]any{"t": "cursor", "rowId": row, "field": "name"})
					cl.send(map[string]any{"t": "ping"})
					cl.send(map[string]any{"t": "lock.release", "rowId": row})
					time.Sleep(loadRoundPause)
				}
			}()
		}
	}
	workers.Wait()
	runTime := time.Since(runStart)

	// Every client must have received every upsert of its room.
	deadline := time.Now().Add(5 * time.Second)
	for {
		missing := 0
		for room := range received {
			for idx := range received[room] {
				if received[room][idx].Load() != loadUpserts {
					missing++
				}
			}
		}
		if missing == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d clients did not receive all %d upserts", missing, loadUpserts)
		}
		time.Sleep(25 * time.Millisecond)
	}
	heapLoaded := heapMiB()
	peakGoroutines := runtime.NumGoroutine()

	// Teardown: close every client, then the server.
	for room := range clients {
		for _, cl := range clients[room] {
			_ = cl.c.Close(websocket.StatusNormalClosure, "done")
		}
	}
	readers.Wait()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := e.h.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	e.srv.Close()

	goroutinesAfter := waitGoroutines(baseGoroutines+2, 10*time.Second)
	heapAfter := heapMiB()

	t.Logf("clients=%d rooms=%d connect=%v run=%v", loadRooms*loadClientsPerRoom, loadRooms, connectTime.Round(time.Millisecond), runTime.Round(time.Millisecond))
	t.Logf("frames received: upserts=%d locks=%d unlocks=%d denied=%d presence=%d other=%d",
		stats.upserts.Load(), stats.locks.Load(), stats.unlocks.Load(), stats.denied.Load(), stats.presence.Load(), stats.other.Load())
	t.Logf("heap MiB: before=%.1f loaded=%.1f after=%.1f; goroutines: before=%d peak=%d after=%d",
		baseHeap, heapLoaded, heapAfter, baseGoroutines, peakGoroutines, goroutinesAfter)

	if n := stats.unexpectedClose.Load(); n != 0 {
		t.Errorf("%d clients were closed unexpectedly", n)
	}
	if stats.locks.Load() == 0 || stats.unlocks.Load() == 0 {
		t.Error("expected lock traffic")
	}
	if goroutinesAfter > baseGoroutines+2 {
		buf := make([]byte, 1<<16)
		buf = buf[:runtime.Stack(buf, true)]
		t.Errorf("goroutine leak: %d before, %d after\n%s", baseGoroutines, goroutinesAfter, buf)
	}
	if heapAfter > baseHeap+8 {
		t.Errorf("heap grew from %.1f to %.1f MiB after the run", baseHeap, heapAfter)
	}
	if heapLoaded > baseHeap+64 {
		t.Errorf("heap under load %.1f MiB is unexpectedly high (base %.1f)", heapLoaded, baseHeap)
	}
}
